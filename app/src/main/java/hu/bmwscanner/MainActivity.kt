package hu.bmwscanner

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Typeface
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.text.method.ScrollingMovementMethod
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import hu.bmwscanner.ds2.Ds2
import hu.bmwscanner.ds2.Ds2Link
import hu.bmwscanner.usb.FtdiDevice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Bring-up and protocol-probing front end for the BMW Scanner 1.4.0 cable.
 *
 * This build deliberately does not pretend to understand the car yet. Its job is to answer the one
 * question that decides the whole project: does the cable behave as a plain FTDI serial port onto
 * the DS2 K-line, or does it expect some proprietary framing of its own? Everything here is aimed
 * at producing a log we can read afterwards.
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        const val ACTION_USB_PERMISSION = "hu.bmwscanner.USB_PERMISSION"
        const val ACTION_COMMAND = "hu.bmwscanner.CMD"
        val PARITIES = listOf(
            "Even (8E1) - DS2 default" to FtdiDevice.Parity.EVEN,
            "None (8N1)" to FtdiDevice.Parity.NONE,
            "Odd (8O1)" to FtdiDevice.Parity.ODD,
        )
    }

    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var usbManager: UsbManager

    private var ftdi: FtdiDevice? = null
    private var link: Ds2Link? = null
    private var devices: List<UsbDevice> = emptyList()

    /** Set by the Stop button; long-running scans poll it. */
    @Volatile
    private var stopRequested = false

    private lateinit var deviceSpinner: Spinner
    private lateinit var channelSpinner: Spinner
    private lateinit var paritySpinner: Spinner
    private lateinit var baudInput: EditText
    private lateinit var hexInput: EditText
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView

    private val logBuffer = StringBuilder()

    private val permissionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != ACTION_USB_PERMISSION) return
            val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
            @Suppress("DEPRECATION")
            val device = intent.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE)
            log(
                if (granted) "USB permission granted for ${device?.deviceName}"
                else "USB permission DENIED for ${device?.deviceName}",
            )
            if (granted) refreshDevices()
        }
    }

    /**
     * Lets the whole app be driven from `adb shell am broadcast`.
     *
     * HyperOS refuses `adb shell input tap` (INJECT_EVENTS), and the phone has one USB port, so
     * while the cable is plugged in there is no way to touch the screen from here. With wireless
     * adb plus this receiver the cable can stay connected and still be driven from the desk, which
     * turns a three-minute round trip in a car park into a few seconds.
     *
     *   adb shell am broadcast -a hu.bmwscanner.CMD --es do full
     *   adb shell am broadcast -a hu.bmwscanner.CMD --es do baudhunt
     *   adb shell am broadcast -a hu.bmwscanner.CMD --es do chars
     *   adb shell am broadcast -a hu.bmwscanner.CMD --es do send --es hex "80 04 00 84" --ei baud 9600
     */
    private val commandReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != ACTION_COMMAND) return
            val what = intent.getStringExtra("do") ?: return
            val baud = intent.getIntExtra("baud", Ds2.BAUD)
            val parity = when (intent.getStringExtra("parity")?.uppercase()) {
                "EVEN" -> FtdiDevice.Parity.EVEN
                "ODD" -> FtdiDevice.Parity.ODD
                else -> FtdiDevice.Parity.NONE
            }
            log(">>> remote command: $what")

            val device = cableDevice()
            if (device == null && what != "save" && what != "clear") {
                log("    no cable present")
                reportUnrecognisedDevices()
                return
            }
            if (device != null && !usbManager.hasPermission(device)) {
                log("    no USB permission - requesting; re-send the command after granting")
                requestPermissionFor(device)
                return
            }

            when (what) {
                "full" -> fullRun()
                "stop" -> { stopRequested = true; log("    stop flag set") }
                "clear" -> { logBuffer.setLength(0); renderLog() }
                "save" -> io.launch { saveLogNow() }
                "baudhunt" -> {
                    val d = if (intent.hasExtra("dtr")) intent.getBooleanExtra("dtr", false) else null
                    val r = if (intent.hasExtra("rts")) intent.getBooleanExtra("rts", false) else null
                    guarded(what) { baudHunt(device!!, d, r) }
                }
                "linestate" -> guarded(what) { probeLineState(device!!) }
                "pulse" -> guarded(what) { pulseResponse(device!!) }
                "handshake" -> guarded(what) { handshakeHunt(device!!) }
                "cbus" -> guarded(what) { cbusHunt(device!!) }
                "cbusverify" -> guarded(what) { cbusVerify(device!!) }
                "vendorinit" -> guarded(what) { vendorInit(device!!) }
                "ledwalk" -> guarded(what) { ledWalk(device!!) }
                "loopback" -> guarded(what) { loopbackCheck(device!!) }
                "latehunt" -> guarded(what) { mcuHunt(device!!) }
                "ledslow" -> {
                    val block = intent.getIntExtra("block", 6000)
                    val rounds = intent.getIntExtra("rounds", 4)
                    guarded(what) { ledRhythm(device!!, block, rounds) }
                }
                "burst" -> guarded(what) { burstCapture(device!!) }
                "beacon" -> {
                    val n = intent.getIntExtra("cycles", 10)
                    guarded(what) { radioBeacon(device!!, n) }
                }
                "slowsend" -> guarded(what) { slowSend(device!!, baud, parity) }
                "chars" -> guarded(what) { characteriseLine(device!!) }
                "sweep" -> guarded(what) { runSweep(device!!) }
                "scan" -> guarded(what) { fullScan(device!!, baud, parity) }
                "send" -> {
                    val hex = intent.getStringExtra("hex") ?: run { log("    need --es hex"); return }
                    val dtr = if (intent.hasExtra("dtr")) intent.getBooleanExtra("dtr", false) else null
                    val rts = if (intent.hasExtra("rts")) intent.getBooleanExtra("rts", false) else null
                    guarded(what) { sendOnce(device!!, baud, parity, hex, dtr, rts) }
                }
                else -> log("    unknown command")
            }
        }
    }

    /**
     * Name of the diagnostic currently running, or null. Guards against two of them sharing the
     * cable.
     *
     * Run 10 showed why this is needed rather than tidy. BURST CAPTURE was started while RADIO
     * BEACON was still going; both opened the device, the beacon's next write came back
     * `IOException: USB bulk OUT failed at offset 0 of 19`, and it died a second into part B. From
     * the car that looks like the beacon simply not working - the owner reported that the radio test
     * "cannot be carried through properly", which is exactly what a diagnostic aborting mid-run
     * sounds like through a radio. A long test that someone is listening to has to either run or say
     * plainly that it did not start.
     */
    private val running = java.util.concurrent.atomic.AtomicReference<String?>(null)

    /** Runs a remote-command diagnostic under the same one-at-a-time guard as the buttons. */
    private fun guarded(what: String, body: () -> Unit) {
        if (!running.compareAndSet(null, what)) {
            log("    $what NOT STARTED: '${running.get()}' is still running; send 'stop' and wait")
            return
        }
        stopRequested = false
        io.launch {
            try {
                body()
            } catch (e: Throwable) {
                log("    $what FAILED: ${e.javaClass.simpleName}: ${e.message}")
            } finally {
                running.set(null)
                saveLogNow()
            }
        }
    }

    /** Finds the cable, settles permission, and runs [body] off the UI thread. */
    private fun withCable(what: String, body: (UsbDevice) -> Unit) {
        val device = cableDevice() ?: run {
            log("$what: no cable found - check the OTG adapter and that it is seated")
            reportUnrecognisedDevices()
            return
        }
        if (!usbManager.hasPermission(device)) {
            log("$what: asking for USB permission - tap OK, then press the button again")
            requestPermissionFor(device)
            return
        }
        if (!running.compareAndSet(null, what)) {
            log("$what NOT STARTED: '${running.get()}' is still running. Press Stop and wait for")
            log("  its '=== end ... ===' line, then try again.")
            return
        }
        stopRequested = false
        disconnect()
        io.launch {
            try {
                body(device)
            } catch (e: Throwable) {
                log("$what FAILED: ${e.javaClass.simpleName}: ${e.message}")
            } finally {
                running.set(null)
                saveLogNow()
            }
        }
    }

    /**
     * Lists every USB device that is present but was not recognised as a cable, with a guess at
     * the chip, so that "no cable found" is actionable rather than a dead end.
     *
     * This matters for the situation the project is actually in. The BMW Scanner cable's vehicle
     * side is dead and it cannot be returned, so the next adapter will be a different one, and the
     * first question will be whether this app can drive it at all. A plain FTDI K-line adapter
     * (`0403:6001`) is already handled by the fallback in [cableDevice]; a CH340 or a PL2303 is a
     * different control-request interface entirely and needs code, not configuration. Printing the
     * ids turns that into a two-second answer instead of a debugging session in a car park.
     */
    private fun reportUnrecognisedDevices() {
        val all = usbManager.deviceList.values.toList()
        if (all.isEmpty()) {
            log("  no USB devices at all - the OTG adapter must pull the USB ID pin low")
            return
        }
        log("  ${all.size} USB device(s) are present but none matched:")
        for (d in all) {
            log("    %04X:%04X  %s  -> %s".format(
                d.vendorId, d.productId, d.productName ?: d.deviceName, usbChipGuess(d.vendorId)))
        }
    }

    /** What a vendor id implies about the USB-serial chip, and so about whether this app fits it. */
    private fun usbChipGuess(vendorId: Int): String = when (vendorId) {
        0x0403 -> "FTDI - this app drives it directly, try it"
        FtdiDevice.BMW_SCANNER_VID -> "re-flashed FTDI, the BMW Scanner id"
        0x1A86 -> "WCH CH340/CH341 - a different interface, needs new driver code"
        0x067B -> "Prolific PL2303 - a different interface, needs new driver code"
        0x10C4 -> "Silicon Labs CP210x - a different interface, needs new driver code"
        0x1A61, 0x05C6 -> "not a serial adapter"
        else -> "unknown vendor - send the ids over"
    }

    /** The BMW cable if present, else any FTDI-looking device, else null. */
    private fun cableDevice(): UsbDevice? {
        devices = FtdiDevice.candidates(usbManager)
        return devices.firstOrNull {
            it.vendorId == FtdiDevice.BMW_SCANNER_VID && it.productId == FtdiDevice.BMW_SCANNER_PID
        } ?: devices.firstOrNull { it.vendorId == FtdiDevice.FTDI_VID }
    }

    /** One-shot: open, send the given hex, print everything that comes back, close. */
    private fun sendOnce(
        device: UsbDevice,
        baud: Int,
        parity: FtdiDevice.Parity,
        hex: String,
        dtr: Boolean? = null,
        rts: Boolean? = null,
    ) {
        var dev: FtdiDevice? = null
        try {
            val tx = Ds2.parseHex(hex)
            dev = FtdiDevice.open(usbManager, device, 0)
            dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
            if (dtr != null || rts != null) {
                dev.setModemControl(dtr, rts)
                Thread.sleep(60)
            }
            dev.purge()
            dev.write(tx)
            val rx = dev.readUntilQuiet(quietMs = 80, overallTimeoutMs = 900)
            log("  $baud ${parity.name} DTR=$dtr RTS=$rts  TX ${Ds2.hex(tx)}")
            log("  RX ${if (rx.isEmpty()) "(silence)" else Ds2.hex(rx)}" +
                if (rx.contentEquals(tx)) "   =TX exactly" else "")
            val ls = dev.lastLineStatus
            if (ls and 0x0E != 0) log("  LINE=0x%02X".format(ls))
        } catch (e: Throwable) {
            log("  send failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }
    }

    // ------------------------------------------------------------------ lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        usbManager = getSystemService(Context.USB_SERVICE) as UsbManager

        val root = buildUi()
        setContentView(root)
        applyWindowInsets(root)

        // A sweep takes about a minute and nobody should have to keep poking the screen awake
        // while sitting in a car waiting for it.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // From targetSdk 34 a runtime-registered receiver must declare its export state, and ours
        // only ever hears our own PendingIntent.
        ContextCompat.registerReceiver(
            this,
            permissionReceiver,
            IntentFilter(ACTION_USB_PERMISSION),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        // Exported on purpose: this is the adb-driven development channel described on
        // commandReceiver. It only starts diagnostics against a cable the user has already granted
        // permission for, and this is a debug build.
        ContextCompat.registerReceiver(
            this,
            commandReceiver,
            IntentFilter(ACTION_COMMAND),
            ContextCompat.RECEIVER_EXPORTED,
        )

        log("BMW DS2 Probe ${BuildConfigVersion.NAME}")
        log("Looking for the cable: VID 0x%04X / PID 0x%04X".format(
            FtdiDevice.BMW_SCANNER_VID, FtdiDevice.BMW_SCANNER_PID))
        log("")
        refreshDevices()
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(permissionReceiver) }
        runCatching { unregisterReceiver(commandReceiver) }
        disconnect()
        io.cancel()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ ui

    private fun buildUi(): ViewGroup {
        val pad = (resources.displayMetrics.density * 8).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        fun row(vararg children: android.view.View) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            children.forEach {
                addView(it, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            }
            root.addView(this, wide())
        }

        fun button(text: String, onClick: () -> Unit) = Button(this).apply {
            this.text = text
            textSize = 12f
            setOnClickListener { onClick() }
        }

        // The one button that matters in the car. Everything below it is for afterwards.
        root.addView(
            Button(this).apply {
                text = "▶  FULL RUN"
                textSize = 18f
                setTypeface(typeface, Typeface.BOLD)
                setOnClickListener { fullRun() }
            },
            wide(),
        )

        deviceSpinner = Spinner(this)
        root.addView(deviceSpinner, wide())

        channelSpinner = Spinner(this).apply {
            adapter = simpleAdapter(listOf("Channel A", "Channel B"))
        }
        paritySpinner = Spinner(this).apply {
            adapter = simpleAdapter(PARITIES.map { it.first })
        }
        baudInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            setText(Ds2.BAUD.toString())
            hint = "baud"
        }

        row(button("Permission") { requestPermission() },
            button("Connect") { connect() },
            button("Disconnect") { disconnect() })

        row(channelSpinner, paritySpinner, baudInput)

        root.addView(
            TextView(this).apply {
                text = "Echo is detected automatically; replies are located by resynchronising " +
                    "on the checksum, not by assuming byte alignment."
                textSize = 11f
                alpha = 0.7f
            },
            wide(),
        )

        hexInput = EditText(this).apply {
            hint = "hex bytes, e.g.  00 04 00  or for DS2: addr then payload"
            setText("00 00")
            setSingleLine(true)
            typeface = Typeface.MONOSPACE
        }
        root.addView(hexInput, wide())

        row(button("Send raw") { sendRaw() },
            button("Send as DS2") { sendDs2() })

        // The two field tests, reachable without a laptop or wifi.
        row(button("RADIO BEACON") { withCable("beacon") { d -> radioBeacon(d) } },
            button("BURST CAPTURE") { withCable("burst") { d -> burstCapture(d) } })

        row(button("LATE-REPLY HUNT  <-- do this one") { withCable("latehunt") { d -> mcuHunt(d) } })

        row(button("LOOPBACK") { withCable("loopback") { d -> loopbackCheck(d) } })

        row(button("ORANGE LED") { withCable("ledslow") { d -> ledRhythm(d) } },
            button("LED WALK") { withCable("ledwalk") { d -> ledWalk(d) } })

        row(button("AUTO-SWEEP") { autoSweep() },
            button("Stop") { stopRequested = true; log("stop requested") })

        row(button("Scan bus") { scanBus() },
            button("Dump EEPROM") { dumpEeprom() },
            button("Descriptors") { io.launch { describeDevices() } })

        row(button("Rescan USB") { refreshDevices() },
            button("Save log") { saveLog() },
            button("Share log") { shareLog() },
            button("Clear") { logBuffer.setLength(0); renderLog() })

        logView = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
            movementMethod = ScrollingMovementMethod()
            setBackgroundColor(Color.argb(24, 128, 128, 128))
            setPadding(pad, pad, pad, pad)
        }
        logScroll = ScrollView(this).apply { addView(logView) }
        root.addView(
            logScroll,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )

        return root
    }

    /**
     * targetSdk 35 and up draw edge to edge, so the layout would otherwise slide under the status
     * bar and the navigation gesture area. Keep the system-bar insets as padding on the root.
     */
    private fun applyWindowInsets(root: android.view.View) {
        val base = (resources.displayMetrics.density * 8).toInt()
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(base + bars.left, base + bars.top, base + bars.right, base + bars.bottom)
            insets
        }
    }

    private fun wide() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )

    private fun simpleAdapter(items: List<String>) =
        ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, items)

    // ------------------------------------------------------------------ logging

    private fun log(line: String) {
        val stamp = SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date())
        synchronized(logBuffer) {
            if (line.isEmpty()) logBuffer.append('\n')
            else line.trimEnd('\n').split('\n').forEach { logBuffer.append(stamp).append("  ").append(it).append('\n') }
        }
        runOnUiThread { renderLog() }
    }

    private fun renderLog() {
        logView.text = synchronized(logBuffer) { logBuffer.toString() }
        logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }

    // ------------------------------------------------------------------ usb plumbing

    private fun refreshDevices() {
        devices = FtdiDevice.candidates(usbManager)
        val labels = devices.map { d ->
            val tag = when {
                d.vendorId == FtdiDevice.BMW_SCANNER_VID && d.productId == FtdiDevice.BMW_SCANNER_PID ->
                    "  <-- BMW Scanner"
                d.vendorId == FtdiDevice.FTDI_VID -> "  <-- FTDI"
                else -> ""
            }
            val perm = if (usbManager.hasPermission(d)) "" else "  [no permission]"
            "%04X:%04X  %s%s%s".format(
                d.vendorId, d.productId, d.productName ?: d.deviceName, tag, perm,
            )
        }
        deviceSpinner.adapter = simpleAdapter(
            labels.ifEmpty { listOf("(no USB devices - is OTG working?)") },
        )
        log("USB rescan: ${devices.size} device(s)")
        devices.forEach { log("  " + it.deviceName + "  ${"%04X:%04X".format(it.vendorId, it.productId)}") }
        if (devices.none { it.vendorId == FtdiDevice.BMW_SCANNER_VID }) {
            log("  note: the BMW Scanner VID 0333 is not among them.")
        }
    }

    private fun selectedDevice(): UsbDevice? =
        devices.getOrNull(deviceSpinner.selectedItemPosition)

    private fun requestPermission() {
        val device = selectedDevice() ?: run { log("no device selected"); return }
        if (usbManager.hasPermission(device)) { log("already have permission"); return }
        requestPermissionFor(device)
    }

    private fun requestPermissionFor(device: UsbDevice) {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pi = PendingIntent.getBroadcast(
            this, 0, Intent(ACTION_USB_PERMISSION).setPackage(packageName), flags,
        )
        usbManager.requestPermission(device, pi)
        log("permission requested for ${device.deviceName}")
    }

    private fun connect() {
        val device = selectedDevice() ?: run { log("no device selected"); return }
        if (!usbManager.hasPermission(device)) { log("no USB permission yet - press Permission"); return }

        disconnect()

        val channel = channelSpinner.selectedItemPosition
        val parity = PARITIES[paritySpinner.selectedItemPosition].second
        val baud = baudInput.text.toString().trim().toIntOrNull() ?: Ds2.BAUD

        io.launch {
            try {
                val dev = FtdiDevice.open(usbManager, device, channel)
                dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
                ftdi = dev
                link = Ds2Link(dev)
                log("connected: channel ${('A' + channel)}, $baud baud, ${parity.name} parity, " +
                    "latency 1 ms, max packet ${dev.maxPacketSize}")
                val (v, i) = FtdiDevice.encodeBaudDivisor(baud)
                log("  baud divisor wValue=0x%04X wIndexHigh=0x%02X".format(v, i))
            } catch (e: Throwable) {
                log("connect FAILED: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
    }

    private fun disconnect() {
        ftdi?.let {
            runCatching { it.close() }
            log("disconnected")
        }
        ftdi = null
        link = null
    }

    // ------------------------------------------------------------------ actions

    private fun withLink(what: String, body: (Ds2Link) -> Unit) {
        val l = link ?: run { log("$what: not connected"); return }
        io.launch {
            try {
                body(l)
            } catch (e: Throwable) {
                log("$what FAILED: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
    }

    private fun sendRaw() {
        val bytes = try {
            Ds2.parseHex(hexInput.text.toString())
        } catch (e: Exception) {
            log("bad hex: ${e.message}"); return
        }
        if (bytes.isEmpty()) { log("nothing to send"); return }
        withLink("send raw") { l ->
            log("--- raw send (no length/checksum added) ---")
            log(l.sendRaw(bytes, timeoutMs = 1200).describe())
        }
    }

    private fun sendDs2() {
        val bytes = try {
            Ds2.parseHex(hexInput.text.toString())
        } catch (e: Exception) {
            log("bad hex: ${e.message}"); return
        }
        if (bytes.isEmpty()) { log("need at least an address byte"); return }
        val addr = bytes[0].toInt() and 0xFF
        val payload = bytes.copyOfRange(1, bytes.size)
        withLink("send ds2") { l ->
            log("--- DS2 to 0x%02X, payload %s ---".format(addr, Ds2.hex(payload).ifEmpty { "(empty)" }))
            log(l.transact(addr, payload, timeoutMs = 1200).describe())
        }
    }

    /**
     * Everything the first session needs, in one press.
     *
     * The cable lives in the car, so there is no separate desk test and no second attempt: whoever
     * is holding the phone gets one go at this, sitting in a driver's seat, probably in the dark.
     * So this does the lot by itself - finds the cable, dumps the descriptors and the EEPROM, runs
     * the full configuration sweep, and saves the log at the end whatever happens - and it never
     * asks a question it could answer for itself.
     */
    private fun fullRun() {
        stopRequested = false
        refreshDevices()

        val device = devices.firstOrNull {
            it.vendorId == FtdiDevice.BMW_SCANNER_VID && it.productId == FtdiDevice.BMW_SCANNER_PID
        } ?: devices.firstOrNull { it.vendorId == FtdiDevice.FTDI_VID }
          ?: devices.firstOrNull()

        if (device == null) {
            log("")
            log("################ FULL RUN - STOPPED ################")
            log("No USB device is visible at all, so the cable is not reaching the phone.")
            log("Check, in this order:")
            log("  1. the OTG adapter is a real OTG one (it must pull the USB ID pin low)")
            log("  2. the cable is seated in the OBD socket")
            log("  3. ignition is in position 2")
            log("Then press FULL RUN again.")
            saveLogNow()
            return
        }

        if (!usbManager.hasPermission(device)) {
            log("Asking Android for permission to use the cable.")
            log("Tap OK (and tick 'always' if offered), then press FULL RUN again.")
            requestPermissionFor(device)
            return
        }

        if (!running.compareAndSet(null, "FULL RUN")) {
            log("FULL RUN NOT STARTED: '${running.get()}' is still running. Press Stop and wait")
            log("  for its '=== end ... ===' line, then try again.")
            return
        }

        disconnect()

        io.launch {
            try {
                log("")
                log("################ FULL RUN ################")
                log("started ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())}")
                log("")

                // Step 1 - what is this thing.
                describeDevices()

                // Step 2 - its EEPROM, which is where the re-flashed VID/PID and the strings live.
                log("")
                var dev: FtdiDevice? = null
                try {
                    dev = FtdiDevice.open(usbManager, device, 0)
                    dev.configure(Ds2.BAUD, FtdiDevice.Parity.EVEN, latencyMs = 1)
                    dumpEepromInto(dev)
                } catch (e: Throwable) {
                    log("EEPROM step failed: ${e.javaClass.simpleName}: ${e.message}")
                    log("(not fatal - the sweep can still run)")
                } finally {
                    runCatching { dev?.close() }
                }

                // Step 3 - the vendor's own start-up, which is the most informed guess we have
                // about what this cable expects. Run first, because if it answers, nothing below
                // matters much.
                log("")
                vendorInit(device)

                // Step 4 - is the receive line even attached to a working bus.
                log("")
                probeLineState(device)

                // Step 4 - is there any bit rate at which the line behaves like a UART at all.
                log("")
                baudHunt(device)

                // Step 4 - what does the wire do with bytes we control.
                log("")
                characteriseLine(device)

                // Step 4 - the question the whole project hangs on.
                log("")
                val best = runSweep(device)

                // Step 5 - if anything at all came back, ask all 256 addresses properly.
                if (best != null && !stopRequested) {
                    log("")
                    fullScan(device, best.baud, best.parity)
                }
            } catch (e: Throwable) {
                log("FULL RUN aborted: ${e.javaClass.simpleName}: ${e.message}")
            } finally {
                running.set(null)
                log("")
                log("################ FULL RUN COMPLETE ################")
                saveLogNow()
                log("Now press SHARE LOG and send it over.")
            }
        }
    }

    /**
     * Tries every plausible line configuration against a short list of candidate ECU addresses and
     * reports which one produced valid DS2 frames.
     *
     * This exists because four things about this cable are unknown at once - which channel the
     * K-line sits on, whether the bus wants even or no parity, whether the DME is on the 9600 baud
     * DS2 bus or the 10400 baud KWP-era one, and whether the hardware echoes transmitted bytes.
     * Toggling 16 combinations by hand while sitting in the car is how mistakes get made, so the
     * phone does it. Takes roughly a minute.
     */
    private fun autoSweep() {
        val device = selectedDevice() ?: run { log("no device selected"); return }
        if (!usbManager.hasPermission(device)) { log("no USB permission yet - press Permission"); return }

        stopRequested = false
        disconnect()
        io.launch { runSweep(device) }
    }

    /** Compact trailing annotation for a probe: the parse complaint plus any UART error flags. */
    private fun describeTrouble(r: hu.bmwscanner.ds2.Ds2Result): String {
        val bits = StringBuilder()
        if (r.note.isNotEmpty()) bits.append("  [").append(r.note).append(']')
        if (r.lineStatus and 0x0E != 0) {
            bits.append("  LINE=0x%02X".format(r.lineStatus))
            if (r.lineStatus and 0x02 != 0) bits.append("/overrun")
            if (r.lineStatus and 0x04 != 0) bits.append("/parity")
            if (r.lineStatus and 0x08 != 0) bits.append("/framing")
        }
        return bits.toString()
    }

    /**
     * Checks that our own CBUS writes actually take effect, by setting each value and reading the
     * pins back.
     *
     * The CBUS hunt returned a flat negative, and a flat negative is only evidence if the stimulus
     * was real. The bitbang capture already taught this lesson once: without confirming that the
     * pin we meant to drive actually moved, "no response" means nothing.
     */
    private fun cbusVerify(device: UsbDevice) {
        log("=== CBUS SELF-CHECK ===")
        var dev: FtdiDevice? = null
        try {
            dev = FtdiDevice.open(usbManager, device, 0)

            dev.dumpEeprom(16).let { w ->
                if (w.size > 11 && w[10] >= 0 && w[11] >= 0) {
                    val b14 = w[10] and 0xFF
                    val b15 = (w[10] shr 8) and 0xFF
                    val b16 = w[11] and 0xFF
                    log("  EEPROM CBUS config:")
                    log("    CBUS0 = ${FtdiDevice.cbusFunction(b14 and 0x0F)}")
                    log("    CBUS1 = ${FtdiDevice.cbusFunction((b14 shr 4) and 0x0F)}")
                    log("    CBUS2 = ${FtdiDevice.cbusFunction(b15 and 0x0F)}")
                    log("    CBUS3 = ${FtdiDevice.cbusFunction((b15 shr 4) and 0x0F)}")
                    log("    CBUS4 = ${FtdiDevice.cbusFunction(b16 and 0x0F)}")
                }
            }

            dev.configure(baudRate = Ds2.BAUD, parity = FtdiDevice.Parity.EVEN, latencyMs = 1)
            log("  driving each value and reading the pins back:")
            var followed = 0
            for (v in 0..15) {
                dev.setCbus(directions = 0x0F, values = v)
                Thread.sleep(25)
                val back = dev.readCbus()
                val ok = back == v
                if (ok) followed++
                log("    set %s  read %s  %s".format(
                    (3 downTo 0).joinToString("") { if (v shr it and 1 == 1) "1" else "0" },
                    if (back == null) "----" else (3 downTo 0).joinToString("") {
                        if (back shr it and 1 == 1) "1" else "0"
                    },
                    if (ok) "ok" else "MISMATCH",
                ))
            }
            log("  $followed of 16 values read back as written")
            if (followed < 12) {
                log("  CBUS writes are NOT taking effect, so the CBUS hunt proved nothing.")
            } else {
                log("  CBUS control works, so the hunt's flat negative is a real result:")
                log("  these pins do not gate the bus on this cable.")
            }
        } catch (e: Throwable) {
            log("  self-check failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }
        log("=== end CBUS self-check ===")
    }

    /**
     * Sends a DS2 frame one byte at a time with a gap between bytes.
     *
     * The vendor's own `bmwscan.ini` carries `Delay=20` and `Delay2=40` under `[Communication]`,
     * and every transmission in this project has been a single back-to-back burst. If the line
     * recovers as slowly as the baud sweep suggests, consecutive bytes smear into one another,
     * while bytes spaced tens of milliseconds apart would each get a clean line to start from.
     */
    private fun slowSend(device: UsbDevice, baud: Int, parity: FtdiDevice.Parity) {
        log("=== SPACED BYTE SEND ===")
        log("One byte at a time, as the vendor ini's Delay/Delay2 values imply.")
        log("")

        var dev: FtdiDevice? = null
        try {
            dev = FtdiDevice.open(usbManager, device, 0)
            for (gapMs in listOf(5L, 20L, 40L, 80L)) {
                for (addr in listOf(0x00, 0x12, 0x60, 0x80)) {
                    if (stopRequested) { log("stopped"); return }
                    dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
                    dev.purge()

                    val frame = Ds2.frame(addr, byteArrayOf(0x00))
                    val collected = ArrayList<Byte>()
                    for (b in frame) {
                        dev.write(byteArrayOf(b))
                        Thread.sleep(gapMs)
                        collected.addAll(dev.readUntilQuiet(quietMs = 5, overallTimeoutMs = 30).toList())
                    }
                    collected.addAll(dev.readUntilQuiet(quietMs = 60, overallTimeoutMs = 400).toList())

                    val raw = collected.toByteArray()
                    val found = Ds2.findFrame(raw, 0, addr)
                    log("  gap=%2dms addr=0x%02X TX %s  RX %s %s".format(
                        gapMs, addr, Ds2.hex(frame),
                        if (raw.isEmpty()) "(silence)" else Ds2.hex(raw),
                        if (found != null && !found.frame.contentEquals(frame)) "<<<<<< FRAME" else "",
                    ))
                }
            }
        } catch (e: Throwable) {
            log("  spaced send failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }
        log("=== end spaced byte send ===")
    }

    /**
     * Transmits a slow, regular on/off pattern so the car radio can be used as a field probe.
     *
     * The owner noticed the byte traffic as an audible pulsing on an empty radio frequency. That is
     * real radiation from the switching edges, and it answers a question no byte-level measurement
     * here can: whether our transmission actually leaves the cable and gets onto the vehicle's
     * wiring. A few centimetres of cable under the dash is a poor antenna; several metres of
     * harness running the length of the car is a good one.
     *
     * So the measurement is a comparison, not a reading, and part A below is the comparison worth
     * making. Unplugging the cable from the socket mid-run is the cruder version of the same idea -
     * it changes the antenna, but it also changes whether the cable's automotive side has power at
     * all, so a difference has two possible causes.
     *
     * One second on, one second off, because that is what the ear picks out of static. 0x55 gives
     * an edge every bit, which is the broadest spectrum we can produce.
     *
     * **The band is FM, and the earlier claim here that it could not be was wrong.** That claim
     * reasoned from the fundamental of a 9600 baud square wave, which is 4.8 kHz and indeed nowhere
     * near 100 MHz. But what radiates is not the fundamental, it is the switching edge: nanosecond
     * rise times carry harmonic content into the VHF band, and on an *empty* FM frequency there is
     * no carrier for the demodulator to capture, so its limiter amplifies whatever noise is present
     * instead of rejecting it. The owner has now heard the pulsing on FM twice, which settles it by
     * measurement. AM would work too; FM is what has actually been shown to work here.
     *
     * Run 8's beacon was still void, but for one reason rather than two. The loop purged the TX
     * FIFO after every 64-byte write, so the chip was handed roughly 15 000 bytes per second while
     * the line at 9600 8N1 can carry 960 - visible in the run-8 log, which reported "14848 bytes
     * transmitted" in one second. All but a fraction were discarded before reaching the wire, and
     * the counter was measuring USB writes rather than anything transmitted. Dropping that purge
     * leaves the bulk write to block on a full FIFO, which paces the loop at the line rate and
     * makes the count true.
     *
     * The plain on/off test has a confound that unplugging the cable does not remove cleanly: the
     * phone is streaming USB at the same time, and USB radiates. Pulsing that follows our write
     * loop could be the K-line drive or could be the bus traffic to the cable. So part A toggles
     * **only the gate**, holding the USB write rate constant: DTR asserted silences the line
     * completely - 0 of 11 520 samples in run 9, ten windows - while the chip goes on shifting the
     * same bytes at the same rate. Pulsing in part A can only be the cable's drive onto the
     * harness. Part B is the original write/idle pattern, kept so the two can be compared.
     */
    private fun radioBeacon(device: UsbDevice, cycles: Int = 10) {
        log("=== RADIO BEACON ===")
        log("Tune the car radio to an empty frequency - FM is where the pulsing has actually")
        log("been heard, so use that; an empty AM frequency works on the same principle.")
        log("")
        log("Part A - GATE: the USB write rate never changes, only the cable's gate. One second")
        log("  driving the line, one second with DTR asserted, which run 9 showed silences it")
        log("  completely. Pulsing here cannot be USB radiation; it is the drive onto the harness.")
        log("Part B - WRITE: the plain one-second-on, one-second-off, for comparison. Pulsing in B")
        log("  but not in A would mean what we have been hearing is the phone's USB, not the car.")
        log("$cycles cycles each. Report the two parts separately.")
        log("")

        var dev: FtdiDevice? = null
        try {
            dev = FtdiDevice.open(usbManager, device, 0)
            dev.configure(baudRate = Ds2.BAUD, parity = FtdiDevice.Parity.NONE, latencyMs = 1)

            // Bytes the line can carry in a one-second window, at 8N1: ten bits per byte.
            val perSecond = Ds2.BAUD / 10
            val chunk = ByteArray((perSecond / 50).coerceIn(1, 64)) { 0x55 }

            /**
             * Writes 0x55 for a second and returns how many bytes the chip accepted. No purge in
             * here: the write blocks on a full FIFO instead, which paces the loop at the line rate.
             */
            fun driveForOneSecond(): Int {
                val until = System.currentTimeMillis() + 1000
                var sent = 0
                while (System.currentTimeMillis() < until && !stopRequested) {
                    dev!!.write(chunk, timeoutMs = 2000)
                    sent += chunk.size
                }
                return sent
            }

            log("  --- part A: gate toggles, USB traffic constant ---")
            for (c in 1..cycles) {
                if (stopRequested) { log("  stopped"); break }

                dev.setModemControl(dtr = false, rts = null)
                val driven = driveForOneSecond()
                log("    cycle %2d/%d: line DRIVEN  - %d bytes, the line carries %d"
                    .format(c, cycles, driven, perSecond))

                dev.setModemControl(dtr = true, rts = null)
                val gated = driveForOneSecond()
                log("    cycle %2d/%d: line GATED   - %d bytes, same rate, nothing on the bus"
                    .format(c, cycles, gated))
            }

            dev.setModemControl(dtr = false, rts = null)
            log("")
            log("  --- part B: write toggles, the original test ---")
            for (c in 1..cycles) {
                if (stopRequested) { log("  stopped"); break }

                val sent = driveForOneSecond()

                // One purge, here at the cut, to drop the tail still queued in the FIFO so it does
                // not sound into the silent second and smear the pattern the test rests on.
                dev.purge()
                log("    cycle %2d/%d: ON  - %d bytes, the line carries %d%s"
                    .format(c, cycles, sent, perSecond,
                        if (sent > perSecond * 2 + 200) "   <-- too many, bytes are being dropped"
                        else ""))

                Thread.sleep(1000)
                log("    cycle %2d/%d: off".format(c, cycles))
            }
        } catch (e: Throwable) {
            log("  beacon failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }
        log("=== end radio beacon ===")
    }

    /**
     * Captures the ~14 ms burst that follows a DTR pulse as raw line levels, and measures its edge
     * timing directly.
     *
     * This settles a question the byte-level evidence cannot. Decoding the burst at eight
     * baud/parity settings gave a byte count that scales with the sample rate and a duration that
     * stays near 14 ms — but that is equally true of a real message read at the wrong rate and of a
     * fixed-duration analogue disturbance. Counting bytes cannot separate them; only the edges can.
     *
     * If the burst is UART data at some rate we never tested, its edges fall on a consistent bit
     * grid and the shortest interval between them is one bit time. If it is a circuit transient,
     * the intervals have no common divisor and cluster around whatever the RC of the line is.
     *
     * Earlier bitbang attempts found nothing, but both were run off the car — where the cable's
     * automotive side is unpowered — and neither pulsed DTR, so neither had anything to capture.
     *
     * Run 8 added a third way of finding nothing. On the car, ignition on, it reported RXD low in
     * 0 of 2400 samples — but that measured this code, not the cable. Between releasing DTR and
     * the first sample sat four control transfers and a bulk write (a baud change, two purges, a
     * bitmode change), which over OTG is comfortably longer than the 14 ms the burst lasts. The
     * comment that claimed the gap was "one control transfer" was wrong.
     *
     * So the pulse now lives inside the bitbang waveform, on the same clock as the samples: bit 4
     * is the DTR pin, bit 0 is TXD held idle high. The release edge is sample-accurate and the
     * capture is already running when it happens. Two things follow that are worth more than the
     * fix itself:
     *
     *  - the time base becomes absolute. One sample is 1/sampleBaud, so the burst's duration is now
     *    an output that can be checked against the ~14 ms the UART decodes gave, instead of that
     *    figure being assumed and fed back in as the calibration.
     *  - the window while DTR is held asserted is a control inside the same capture. That is the
     *    state in which the line is known to fall completely silent, so it should read idle high;
     *    if it does not, the capture itself is suspect and nothing after it counts.
     *
     * Both pulse polarities are tried, because which pin level means "asserted" rests on FTDI's
     * active-low DTR# convention rather than on anything measured here, and a run with no pulse at
     * all is included so that a burst can be attributed to the pulse rather than to the ambient.
     */
    private fun burstCapture(device: UsbDevice) {
        log("=== DTR BURST CAPTURE ===")
        log("The DTR pulse is part of the bitbang waveform, so the capture is already")
        log("running when DTR is released, and one sample is exactly 1/sample clock.")
        log("Each run also reports whether the sample clock stalled - if it did, ignore it.")
        log("")

        var dev: FtdiDevice? = null
        try {
            dev = FtdiDevice.open(usbManager, device, 0)
            dev.configure(baudRate = 19200, parity = FtdiDevice.Parity.NONE, latencyMs = 1)

            val mult = calibrateBitbangClock(dev)
            log("")

            for (sampleRate in listOf(115200, 57600)) {
                if (stopRequested) { log("stopped"); return }
                burstRun(dev, sampleRate, mult, "DTR# low = asserted, the FTDI convention", true)
                if (stopRequested) { log("stopped"); return }
                burstRun(dev, sampleRate, mult, "inverted, in case this cable's gate is the other way up", false)
            }

            // Same total length as a pulsed run, so it is a matched control: activity that only
            // appears in a 100 ms window and not in a 30 ms one would otherwise look like the
            // pulse's doing when it is really a matter of how long we watched.
            if (!stopRequested) {
                burstRun(dev, 115200, mult, "CONTROL: no pulse, DTR held released", null, tailMs = 130)
            }

            // If the control run finds the event too, the question stops being what triggers it and
            // becomes how often it comes. A coarse clock buys a window long enough to see several,
            // which is the only way to get the interval; 52 us per sample is plenty to time an
            // event that lasts 14 ms even though it is far too coarse for bit times.
            if (!stopRequested) {
                burstRun(dev, 19200, mult, "LISTEN: 600 ms, DTR held released, coarse clock", null,
                    tailMs = 600)
            }
        } catch (e: Throwable) {
            log("  burst capture failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }
        log("=== end burst capture ===")
    }

    /**
     * Measures how fast synchronous bitbang actually samples, rather than assuming the programmed
     * baud rate is the sample rate.
     *
     * It is not, and the rewritten capture caught it on its first run: 14976 samples asked for at
     * 115200 came back in 43 ms, where 115200 samples per second needs 130. The FT232R's bitbang
     * clock runs at a multiple of the baud the divisor encodes - libftdi hard-codes a factor for
     * exactly this reason. Every number the burst capture produces, bit times and durations alike,
     * scales directly with that factor, so it is measured here instead of trusted.
     *
     * A low programmed rate over a long waveform keeps the USB overhead to a few percent of the
     * elapsed time, which is what makes the division meaningful.
     */
    private fun calibrateBitbangClock(dev: FtdiDevice): Int {
        val programmed = 9600
        val samples = 12000
        val wave = ByteArray(samples) { 0x11 }

        val cap = dev.syncBitbangStream(wave, programmed, driverMask = 0x11, clockMultiplier = 1)
        if (cap.samples.size < samples || cap.elapsedMs <= 0) {
            log("  clock calibration inconclusive (${cap.samples.size} of $samples samples came " +
                "back in ${cap.elapsedMs} ms); falling back to x4")
            return 4
        }

        val rate = cap.samples.size * 1000.0 / cap.elapsedMs
        val factor = Math.round(rate / programmed).toInt().coerceIn(1, 16)
        log("  clock calibration: $samples samples, divisor set for $programmed, back in " +
            "${cap.elapsedMs} ms")
        log("  -> %.0f samples/s, so the bitbang clock is the programmed baud x%d".format(rate, factor))
        return factor
    }

    /**
     * One pulse-and-capture run at [sampleRate] samples per second, with [clockMultiplier] as
     * measured by [calibrateBitbangClock].
     *
     * [assertPinLow] true drives the DTR pin low to assert it (FTDI's active-low DTR#, which is
     * what `setModemControl(dtr = true)` does), false drives it high, and null holds the released
     * state throughout - the control run that says whether any burst is really the pulse's doing.
     */
    private fun burstRun(
        dev: FtdiDevice,
        sampleRate: Int,
        clockMultiplier: Int,
        label: String,
        assertPinLow: Boolean?,
        pulseMs: Int = 100,
        tailMs: Int = 30,
    ) {
        val usPerSample = 1_000_000.0 / sampleRate
        val pulseSamples = if (assertPinLow == null) 0 else sampleRate * pulseMs / 1000
        val tailSamples = sampleRate * tailMs / 1000

        // bit 0 = TXD, held high so the transmit line stays idle; bit 4 = the DTR pin.
        val released: Byte = if (assertPinLow == false) 0x01 else 0x11
        val asserted: Byte = if (assertPinLow == false) 0x11 else 0x01
        val wave = ByteArray(pulseSamples + tailSamples) { if (it < pulseSamples) asserted else released }

        log("  --- $sampleRate samples/s (%.2f us/sample); $label ---".format(usPerSample))

        val cap = dev.syncBitbangStream(wave, sampleRate, driverMask = 0x11, clockMultiplier = clockMultiplier)
        log("    %d of %d samples back in %d ms (clock needs %.0f ms)%s".format(
            cap.samples.size, wave.size, cap.elapsedMs, cap.expectedMs,
            if (cap.stalled) "   <-- CLOCK STALLED, timings below mean nothing" else ""))

        if (cap.samples.isEmpty()) { log("    nothing came back"); log(""); return }

        val levels = IntArray(cap.samples.size) { (cap.samples[it].toInt() shr 1) and 1 }

        // Both windows get the same treatment. The one with DTR asserted is not padding: it is the
        // state in which the line is documented to fall completely silent, so it doubles as a
        // control taken on the same clock, in the same run, within milliseconds of the measurement.
        if (pulseSamples > 0) {
            analyseWindow("DTR asserted", levels, 0, minOf(pulseSamples, levels.size), usPerSample)
        }
        if (levels.size > pulseSamples) {
            val name = if (pulseSamples > 0) "after the release" else "DTR released throughout"
            analyseWindow(name, levels, pulseSamples, levels.size, usPerSample)
        } else {
            log("    capture ended before the release edge")
        }
        log("")
    }

    /**
     * Reports what the receive line did across `[from, to)` of a bitbang capture.
     *
     * The edge statistics are the whole point of the capture, so they are applied to every window
     * rather than only to the one a burst is expected in - the run that found activity while DTR
     * was held in the unexpected state would otherwise have been a bare sample count.
     *
     * Where the activity sits inside the window matters as much as how much there is: something
     * that starts tens of milliseconds after a level change is a different phenomenon from
     * something present throughout, and a count alone cannot tell them apart.
     */
    private fun analyseWindow(
        name: String,
        levels: IntArray,
        from: Int,
        to: Int,
        usPerSample: Double,
    ) {
        val span = to - from
        val low = (from until to).count { levels[it] == 0 }
        log("    $name: $span samples (%.1f ms), RXD low in $low".format(span * usPerSample / 1000))
        if (low == 0) {
            log("      line idle high throughout")
            return
        }

        // Split the window into separate events rather than quoting one first-to-last span. The
        // repeat interval is the thing that distinguishes a module broadcasting on a schedule from
        // a one-off, and a single span silently merges two events into one implausibly long one.
        val gapSamples = (2000.0 / usPerSample).toInt().coerceAtLeast(2)
        val events = ArrayList<IntArray>()
        var i = from
        while (i < to) {
            if (levels[i] != 0) { i++; continue }
            var end = i
            var j = i + 1
            var highRun = 0
            while (j < to) {
                if (levels[j] == 0) { end = j; highRun = 0 } else if (++highRun >= gapSamples) break
                j++
            }
            events.add(intArrayOf(i, end))
            i = j
        }

        log("      ${events.size} event(s), counting a gap of 2 ms of idle as a separation")
        var prevEnd = -1
        for ((k, ev) in events.withIndex()) {
            val lowIn = (ev[0]..ev[1]).count { levels[it] == 0 }
            val width = ev[1] - ev[0] + 1
            log("      event ${k + 1}: starts %.2f ms in, lasts %.2f ms, %d%% low%s".format(
                (ev[0] - from) * usPerSample / 1000, width * usPerSample / 1000,
                lowIn * 100 / width,
                if (prevEnd < 0) ""
                else ", %.2f ms after the previous ended".format((ev[0] - prevEnd) * usPerSample / 1000)))
            prevEnd = ev[1]
        }

        val target = events.maxByOrNull { it[1] - it[0] } ?: return
        val runs = ArrayList<Int>()
        var cur = levels[target[0]]
        var n = 1
        for (p in (target[0] + 1)..target[1]) {
            if (levels[p] == cur) n++ else { runs.add(n); cur = levels[p]; n = 1 }
        }
        runs.add(n)

        val hist = runs.groupingBy { it }.eachCount().toSortedMap()
        log("      longest event: ${runs.size} level runs, lengths in samples " +
            if (hist.size <= 20) "$hist" else "${hist.entries.take(20)} ... (${hist.size} distinct)")

        // The earlier version took the shortest run as the bit time, which is vacuous the moment a
        // one-sample run exists: every length is a whole multiple of one, so the test returned 100%
        // regardless of what the signal was. Search the candidates instead and report the best fit.
        val (unit, share) = bestBitGrid(runs, (target[1] - target[0] + 1) / 4)
        if (unit == 0) {
            log("      too few runs to test for a bit grid")
            return
        }
        log("      best-fitting bit time over all candidates: $unit samples = %.1f us -> %d baud"
            .format(unit * usPerSample, (1_000_000.0 / (unit * usPerSample)).toInt()))
        log("      %d%% of runs are whole multiples of it".format(share))
        log("      -> UART data sampled this far above its bit rate gives a run-length histogram")
        log("         clustered at multiples of one bit and empty in between, i.e. well over 90%.")
        log("         A smooth spread of lengths with no preferred spacing is a transient.")
    }

    /**
     * Finds the candidate bit time that best explains [runs], and the share of runs it explains.
     *
     * Scoring every candidate rather than assuming the shortest run is one bit matters because the
     * two hypotheses this project is trying to separate differ precisely here. Real UART data read
     * well above its bit rate produces run lengths at whole multiples of the bit time and nothing
     * between them, so some candidate scores near 100%. A transient produces a smooth spread, and
     * then no candidate scores well - a result that only means something if we actually looked for
     * the best one.
     *
     * Candidates start at two samples: one sample divides everything and says nothing.
     */
    private fun bestBitGrid(runs: List<Int>, maxUnit: Int): Pair<Int, Int> {
        if (runs.size < 8 || maxUnit < 2) return 0 to 0
        var bestUnit = 0
        var bestHits = -1
        for (unit in 2..maxUnit) {
            val hits = runs.count { r ->
                val m = r.toDouble() / unit
                m >= 0.75 && kotlin.math.abs(m - kotlin.math.round(m)) < 0.2
            }
            if (hits > bestHits) { bestHits = hits; bestUnit = unit }
        }
        return bestUnit to (bestHits * 100 / runs.size)
    }

    /**
     * Walks the CBUS pins and the transmit line slowly enough to be watched, so the cable's LEDs
     * can be mapped by eye.
     *
     * The EEPROM puts CBUS0-3 in IOMODE, and on an FTDI cable that is where indicator LEDs usually
     * hang. The owner reports a green LED that lights when the cable is in the car - consistent
     * with vehicle power - and an orange one that blinked while we were transmitting. Establishing
     * which signal drives which LED turns a guess into a known, and an LED that follows CBUS is
     * also independent physical proof that those writes reach the board.
     */
    private fun ledWalk(device: UsbDevice) {
        log("=== LED WALK - watch the cable ===")
        log("Each step is held for 2 seconds. Note any LED that changes.")
        log("")

        var dev: FtdiDevice? = null
        try {
            dev = FtdiDevice.open(usbManager, device, 0)
            dev.configure(baudRate = Ds2.BAUD, parity = FtdiDevice.Parity.NONE, latencyMs = 1)

            log("  step 1: all CBUS pins LOW")
            dev.setCbus(directions = 0x0F, values = 0x00)
            Thread.sleep(2000)

            for (bit in 0..3) {
                if (stopRequested) { log("stopped"); return }
                log("  step ${bit + 2}: CBUS$bit HIGH, the rest LOW")
                dev.setCbus(directions = 0x0F, values = 1 shl bit)
                Thread.sleep(2000)
            }

            log("  step 6: all CBUS pins HIGH")
            dev.setCbus(directions = 0x0F, values = 0x0F)
            Thread.sleep(2000)

            // Back to normal UART so the transmit test is clean.
            dev.setBitMode(0x00, FtdiDevice.BITMODE_RESET)
            dev.configure(baudRate = Ds2.BAUD, parity = FtdiDevice.Parity.NONE, latencyMs = 1)

            log("  step 7: continuous transmission for 4 seconds (no CBUS driving)")
            val until = System.currentTimeMillis() + 4000
            while (System.currentTimeMillis() < until && !stopRequested) {
                dev.write(ByteArray(32) { 0x55 })
                Thread.sleep(20)
            }

            log("  step 8: DTR asserted for 3 seconds")
            dev.setModemControl(dtr = true, rts = null)
            Thread.sleep(3000)
            log("  step 9: DTR released")
            dev.setModemControl(dtr = false, rts = null)
            Thread.sleep(1500)

            log("  step 10: RTS asserted for 3 seconds")
            dev.setModemControl(dtr = null, rts = true)
            Thread.sleep(3000)
            log("  step 11: RTS released")
            dev.setModemControl(dtr = null, rts = false)

            // Step 7 established that the orange LED is a transmit indicator, but it did so with a
            // single uninterrupted burst: the eye was asked whether a light was on, which is a
            // judgement, not an observation. On 2026-10-20 the owner reported the orange LED never
            // blinking at all while the cable was in the car, and a steady-state question cannot
            // distinguish "it has stopped working" from "it was not being watched at the right
            // moment". A square on/off pattern can: either the light follows the pattern or it does
            // not, and that is answerable without judging brightness.
            log("")
            log("  step 12: orange LED re-test - three slow transmit pulses.")
            log("  Watch the ORANGE LED only. Does it follow this pattern, or stay dark?")
            dev.setModemControl(dtr = false, rts = null)
            dev.configure(baudRate = Ds2.BAUD, parity = FtdiDevice.Parity.NONE, latencyMs = 1)
            for (c in 1..3) {
                if (stopRequested) { log("  stopped"); break }

                log("    pulse $c/3: TRANSMITTING for 2 s  <-- orange should be blinking now")
                val txUntil = System.currentTimeMillis() + 2000
                var sent = 0
                while (System.currentTimeMillis() < txUntil && !stopRequested) {
                    dev.write(ByteArray(16) { 0x55 }, timeoutMs = 2000)
                    sent += 16
                }
                dev.purge()
                log("    pulse $c/3: silent for 2 s ($sent bytes went out, the line carries " +
                    "${Ds2.BAUD / 10} per second)")
                Thread.sleep(2000)
            }
        } catch (e: Throwable) {
            log("  LED walk failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }
        log("=== end LED walk ===")
    }

    /**
     * Listens far longer than anything before it, looking for a reply that is separated in time
     * from the transmission artefact.
     *
     * Run 13 opened the cable and found a ~28-pin NEC part sitting between the OBD side and the
     * FT232R, where a microcontroller goes. If it is one, nothing we have ever sent was addressed to
     * anything that could answer — and, more usefully, a microcontroller takes time. It boots after
     * a reset, it thinks before replying, and it answers whenever it is ready rather than inside the
     * window a K-line transaction would use.
     *
     * Every read in this project has closed far too early to see that. `Ds2Link.sendRaw` stops 40 ms
     * after the line falls quiet, `vendorInit` stops 150 ms after, and on this cable the first thing
     * to arrive is *always* the artefact — so the quiet timer has been starting immediately and
     * every read has ended a few tens of milliseconds after transmission. A reply at 300 ms has
     * never once been visible. That is a flaw in the measurements, not in the cable.
     *
     * So: fixed windows, no early exit, arrival times recorded. The artefact is immediate and fixed
     * in duration, which makes the discriminator simple — **anything arriving after the first 25 ms
     * is not the artefact**, whatever it contains. That is the thing to look for, and it needs no
     * equipment beyond the phone and the car.
     *
     * Two halves. A silent listen after a DTR pulse, in case DTR resets the part and it announces
     * itself late; and a probe-then-listen, in case it answers only when spoken to.
     */
    private fun mcuHunt(device: UsbDevice) {
        log("=== LATE-REPLY HUNT ===")
        log("Listening for a fixed window with no early exit, and timestamping what arrives.")
        log("The transmission artefact is immediate, so ANYTHING after 25 ms is something else.")
        log("")

        val rates = listOf(9600, 10400, 19200, 38400, 57600, 115200)
        var anyLate = false

        var dev: FtdiDevice? = null
        try {
            dev = FtdiDevice.open(usbManager, device, 0)

            log("  --- part 1: DTR pulse, then 1.2 s of silence ---")
            log("  If DTR resets the part, a boot message can arrive long after we stopped looking.")
            for (baud in rates) {
                for (parity in listOf(FtdiDevice.Parity.NONE, FtdiDevice.Parity.EVEN)) {
                    if (stopRequested) { log("  stopped"); return }
                    dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
                    dev.setModemControl(dtr = true, rts = null)
                    Thread.sleep(100)
                    dev.purge()
                    dev.setModemControl(dtr = false, rts = null)
                    if (reportWindow(dev.readTimed(1200), "%6d %-4s pulse".format(baud, parity.name))) {
                        anyLate = true
                    }
                }
            }

            log("")
            log("  --- part 2: a probe, then 600 ms of listening ---")
            log("  In case it only speaks when spoken to. Probes are deliberately varied.")
            val probes = listOf(
                byteArrayOf(0x00),
                byteArrayOf(0xFF.toByte()),
                byteArrayOf(0x81.toByte(), 0x11, 0xF1.toByte(), 0x81.toByte(), 0x04),
                Ds2.frame(0x00, byteArrayOf(0x00)),
            )
            for (baud in rates) {
                for ((i, probe) in probes.withIndex()) {
                    if (stopRequested) { log("  stopped"); return }
                    dev.configure(baudRate = baud, parity = FtdiDevice.Parity.NONE, latencyMs = 1)
                    dev.setModemControl(dtr = false, rts = null)
                    dev.purge()
                    dev.write(probe)
                    val tag = "%6d probe%d %s".format(baud, i + 1, Ds2.hex(probe))
                    if (reportWindow(dev.readTimed(600), tag)) anyLate = true
                }
            }
        } catch (e: Throwable) {
            log("  late-reply hunt failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }

        log("")
        log(if (anyLate) {
            "SOMETHING ANSWERED LATE. Those lines are the first real result in this project - " +
                "they cannot be the artefact, which is immediate."
        } else {
            "Nothing arrived later than 25 ms anywhere. Every byte was the immediate artefact."
        })
        log("=== end late-reply hunt ===")
    }

    /**
     * Prints one listening window, split at 25 ms, and says whether anything came in late.
     *
     * The split is the whole point. Early bytes are the transmission artefact and have been
     * accounted for since run 9; late bytes cannot be, so they are reported in full regardless of
     * whether they parse as anything.
     */
    private fun reportWindow(batches: List<Pair<Long, ByteArray>>, tag: String): Boolean {
        val early = batches.filter { it.first < 25 }.sumOf { it.second.size }
        val late = batches.filter { it.first >= 25 }
        val lateBytes = late.sumOf { it.second.size }

        if (lateBytes == 0) {
            log("    $tag: $early byte(s) immediately, nothing after 25 ms")
            return false
        }
        log("    $tag: $early immediate, then $lateBytes LATE byte(s)  <<<<<<")
        for ((at, chunk) in late) {
            log("        at %4d ms: %s".format(at, Ds2.hex(chunk.copyOfRange(0, minOf(32, chunk.size)))))
        }
        return true
    }

    /**
     * Asks whether the receive line follows the transmit line, and how closely.
     *
     * This is the measurement the project should have made first and never made at all. A K-line is
     * a **single wire**: whatever the transmitter pulls onto it is what the receiver sees. So
     * driving a known square wave on TXD and sampling RXD on the same clock answers, with a number
     * rather than a judgement, whether the cable's line pin is on a live bus — and it needs no
     * multimeter, no listening, and no second car.
     *
     * Why the existing evidence cannot answer it. Off the car the receive line never moves while
     * transmitting; on the car it does. That looks like a clean comparison and is not, because the
     * cable's automotive side is powered from the OBD socket: the desk run tests an *unpowered*
     * transceiver, so it cannot separate "the line pin is not connected" from "the driver is dead".
     * Both hypotheses predict silence off the car and something on it.
     *
     * What separates them is the *shape* of the relationship, measured in the car:
     *
     *  - **A clean echo**, RXD mirroring TXD at a fixed small lag, means the pin is on a live bus and
     *    the line driver works. Then nothing is wrong with the hardware and the protocol was the
     *    problem all along — which would be very good news, because no initialisation sequence has
     *    ever been sent (see `docs/findings.md`, "Reopened").
     *  - **A smeared echo**, following TXD but with edges displaced by tens of microseconds, is a
     *    driver too slow or too weak for the rate, and predicts exactly the unreadable bytes that
     *    every baud sweep has produced.
     *  - **No relationship at all** means RXD is not seeing TXD, which is what an unconnected line
     *    pin looks like — and `probeLineState` has been printing *"what an unconnected, undriven
     *    input looks like"* on every car run since the first one.
     *
     * Four edge rates, from 2 ms per level down to 50 us. A bandwidth problem shows up as a match
     * that is high when the edges are slow and collapses as they speed up; an unconnected pin is
     * equally dead at every rate. The slowest rate is repeated with the gate shut as a control: an
     * echo that survives DTR assertion is not coming through the transceiver at all.
     */
    private fun loopbackCheck(device: UsbDevice) {
        log("=== TXD -> RXD LOOPBACK ===")
        log("A K-line is one wire, so what we drive is what we should hear. Driving a square")
        log("wave on TXD and sampling RXD on the same clock says whether our line pin is on a")
        log("live bus - with a number, and without a multimeter.")
        log("")

        var dev: FtdiDevice? = null
        try {
            dev = FtdiDevice.open(usbManager, device, 0)
            dev.configure(baudRate = 19200, parity = FtdiDevice.Parity.NONE, latencyMs = 1)

            val mult = calibrateBitbangClock(dev)
            log("")

            for (levelUs in listOf(2000, 500, 100, 50)) {
                if (stopRequested) { log("stopped"); return }
                loopbackRun(dev, levelUs, mult, gateShut = false)
            }
            if (!stopRequested) {
                log("  CONTROL, gate shut: an echo that survives this is not coming via the bus")
                loopbackRun(dev, 2000, mult, gateShut = true)
            }
        } catch (e: Throwable) {
            log("  loopback failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }
        log("=== end loopback ===")
    }

    /**
     * One loopback run: a square wave of [levelUs] per level on TXD, RXD sampled on the same clock.
     *
     * [gateShut] drives the DTR pin low for the whole run, which run 9 showed silences the line
     * completely, so it serves as the control.
     */
    private fun loopbackRun(dev: FtdiDevice, levelUs: Int, clockMultiplier: Int, gateShut: Boolean) {
        val sampleRate = 115200
        val usPerSample = 1_000_000.0 / sampleRate
        val perLevel = (sampleRate.toLong() * levelUs / 1_000_000).toInt().coerceAtLeast(4)
        val levels = (6000 / perLevel).coerceIn(8, 400)

        // bit 4 is the DTR pin: high releases the gate, low asserts it. bit 0 is TXD.
        val gateBit = if (gateShut) 0x00 else 0x10
        val wave = ByteArray(levels * perLevel) { i ->
            val high = (i / perLevel) % 2 == 1
            (gateBit or if (high) 0x01 else 0x00).toByte()
        }

        val cap = dev.syncBitbangStream(wave, sampleRate, driverMask = 0x11, clockMultiplier = clockMultiplier)
        val tag = "%4d us/level (%d samples), %d levels".format(levelUs, perLevel, levels)
        if (cap.stalled || cap.samples.size < wave.size / 2) {
            log("  $tag: capture unusable (${cap.samples.size} of ${wave.size} in ${cap.elapsedMs} ms)")
            return
        }

        val n = cap.samples.size
        val txd = IntArray(n) { wave[it].toInt() and 1 }
        val rxd = IntArray(n) { (cap.samples[it].toInt() shr 1) and 1 }

        val lows = rxd.count { it == 0 }
        if (lows == 0 || lows == n) {
            log("  $tag: RXD never moved (constant ${if (lows == 0) "high" else "low"})")
            return
        }

        // Cross-correlate against the wave we drove, allowing for transceiver delay, and against
        // its inverse, because a transceiver may well invert.
        val maxLag = (perLevel * 2).coerceAtMost(n / 4)
        var bestLag = 0
        var bestHits = -1
        var bestInverted = false
        for (lag in 0..maxLag) {
            var same = 0
            for (i in lag until n) if (rxd[i] == txd[i - lag]) same++
            val span = n - lag
            if (same > bestHits) { bestHits = same; bestLag = lag; bestInverted = false }
            if (span - same > bestHits) { bestHits = span - same; bestLag = lag; bestInverted = true }
        }
        val pct = bestHits * 100 / (n - bestLag)

        log("  $tag:")
        log("    RXD low in $lows of $n samples; best match %d%% at a lag of %d samples (%.1f us)%s"
            .format(pct, bestLag, bestLag * usPerSample, if (bestInverted) ", INVERTED" else ""))
        log("    " + when {
            pct >= 90 -> "-> RXD follows TXD. The line pin is on a live bus and the driver works."
            pct >= 65 -> "-> follows TXD but smeared: the driver cannot keep up with this edge rate."
            else -> "-> no relationship. RXD is not seeing TXD at this rate."
        })
    }

    /**
     * The orange-LED test, slowed down until the answer is a yes or no instead of an impression.
     *
     * Step 12 used 2 s blocks and got back an honest report of something genuinely hard to see:
     * *"it blinks, very fast, and there is a pause, but there is a lot of short and a lot of long in
     * it, if I wanted to write it musically — a bit like Morse SOS"*. Of course. Continuous 0x55 at
     * 9600 is a 4.8 kHz square wave, so whatever the LED does inside a block is far beyond what an
     * eye can resolve, and the eye is left integrating flicker and guessing at the envelope. No
     * rhythm can be concluded from that, in either direction.
     *
     * Six-second blocks remove the judgement. Nobody has to assess brightness or tempo, only
     * whether the light is **out**, and six seconds of darkness is not something an eye invents.
     *
     * Two parts, asking different things:
     *
     *  - **Part 1, write toggles.** Transmit, then stop. A dark block means the LED follows
     *    transmission, which is all the transmit-indicator claim needs.
     *  - **Part 2, gate toggles.** Transmit throughout, but assert DTR for alternate blocks. DTR
     *    silences the bus completely — 0 of 11 520 samples in run 9, ten windows. So if the LED goes
     *    dark here too it sits *downstream* of the gate and is reporting what actually reaches the
     *    bus. If it stays lit, it is an indicator upstream of the gate and says nothing about the
     *    bus at all.
     *
     * Run 11 answered it, and the answer was the unhelpful one: bursts of seven or eight very fast
     * flashes separated by about a tenth of a second, repeating. That is the USB fill-and-drain
     * cycle — the 19-byte chunk below fills the FT232R's 128-byte transmit FIFO in seven writes, and
     * 128 bytes at 9600 8N1 take 133 ms to drain while the host is held off. The LED flashes once
     * per bulk write, so it only ever confirmed that the host hands bytes to the chip. Kept because
     * establishing what an indicator does *not* indicate is worth the hundred lines.
     */
    private fun ledRhythm(device: UsbDevice, blockMs: Int = 6000, rounds: Int = 4) {
        log("=== ORANGE LED, SLOWLY ===")
        log("Watch the ORANGE LED. Do not judge brightness or tempo - only whether it goes OUT.")
        log("Blocks are ${blockMs / 1000} seconds long and are announced here as they start.")
        log("")

        var dev: FtdiDevice? = null
        try {
            dev = FtdiDevice.open(usbManager, device, 0)
            dev.configure(baudRate = Ds2.BAUD, parity = FtdiDevice.Parity.NONE, latencyMs = 1)

            val perSecond = Ds2.BAUD / 10
            val chunk = ByteArray((perSecond / 50).coerceIn(1, 64)) { 0x55 }

            /** Transmits 0x55 for [ms], paced by the FIFO rather than by a purge. */
            fun transmitFor(ms: Int): Int {
                val until = System.currentTimeMillis() + ms
                var sent = 0
                while (System.currentTimeMillis() < until && !stopRequested) {
                    dev!!.write(chunk, timeoutMs = 2000)
                    sent += chunk.size
                }
                return sent
            }

            log("  --- PART 1: transmitting, then not transmitting ---")
            dev.setModemControl(dtr = false, rts = null)
            for (r in 1..rounds) {
                if (stopRequested) { log("  stopped"); break }

                log("    round $r/$rounds: TRANSMITTING for ${blockMs / 1000} s")
                val sent = transmitFor(blockMs)
                dev.purge()
                log("    round $r/$rounds: SILENT for ${blockMs / 1000} s  ->  is the orange LED out?" +
                    "   ($sent bytes went out, the line carries $perSecond per second)")
                Thread.sleep(blockMs.toLong())
            }

            log("")
            log("  --- PART 2: transmitting the whole time, only the gate toggles ---")
            for (r in 1..rounds) {
                if (stopRequested) { log("  stopped"); break }

                dev.setModemControl(dtr = false, rts = null)
                log("    round $r/$rounds: line DRIVEN for ${blockMs / 1000} s")
                transmitFor(blockMs)

                dev.setModemControl(dtr = true, rts = null)
                log("    round $r/$rounds: line GATED for ${blockMs / 1000} s, still transmitting" +
                    "  ->  is the orange LED out?")
                transmitFor(blockMs)
            }
            dev.setModemControl(dtr = false, rts = null)
            dev.purge()
        } catch (e: Throwable) {
            log("  orange LED test failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }
        log("=== end orange LED test ===")
    }

    /**
     * Replays the exact start-up sequence the vendor's own software performs, recovered from a USB
     * capture of BMWScan140.exe running against this cable.
     *
     * The capture (docs/field-logs/2026-10-18-run6-vendor-usb-capture.md) shows it reads the whole
     * EEPROM, then:
     *
     *     SIO reset -> GET_MODEM_STATUS -> 19200 baud -> 8N1
     *     -> purge RX x12 -> purge TX
     *     -> DTR asserted -> ~100 ms -> DTR released
     *     -> wait for the cable to say something
     *
     * Three things in that were never tried here: 19200 baud, 8N1 alongside it, and above all a
     * DTR *pulse*. The handshake hunt only ever held DTR in a steady state, and found that holding
     * it asserted killed the line - which is consistent with it being a reset that needs releasing,
     * not a level that needs setting.
     *
     * Note what this sequence does NOT contain: a single byte of serial data. The vendor software
     * decides whether the hardware is sound before it ever talks to the car, by pulsing DTR and
     * waiting for the cable to announce itself.
     */
    private fun vendorInit(device: UsbDevice) {
        log("=== VENDOR INIT REPLAY ===")
        log("Reproducing BMWScan140.exe's start-up exactly, from the USB capture.")
        log("")

        for (baud in listOf(19200, 9600, 10400, 38400)) {
            for (parity in listOf(FtdiDevice.Parity.NONE, FtdiDevice.Parity.EVEN)) {
                if (stopRequested) { log("stopped"); return }
                var dev: FtdiDevice? = null
                try {
                    dev = FtdiDevice.open(usbManager, device, 0)
                    dev.configure(baudRate = baud, parity = parity, latencyMs = 1)

                    repeat(12) { dev.purge() }

                    // The pulse. Assert, hold, release - then listen without sending anything.
                    dev.setModemControl(dtr = true, rts = null)
                    Thread.sleep(100)
                    dev.setModemControl(dtr = false, rts = null)

                    val heard = dev.readUntilQuiet(quietMs = 150, overallTimeoutMs = 1500)
                    log("  %5d %-4s  DTR pulse -> %s".format(
                        baud, parity.name,
                        if (heard.isEmpty()) "(silence)"
                        else "%d byte(s): %s".format(heard.size, Ds2.hex(heard.copyOfRange(0, minOf(48, heard.size)))),
                    ))

                    // And with a DS2 request afterwards, in case it needs prompting.
                    val l = Ds2Link(dev)
                    val r = l.identify(0x00, timeoutMs = 400)
                    log("        then ident 0x00 -> %s%s".format(
                        if (r.raw.isEmpty()) "(silence)" else Ds2.hex(r.raw),
                        if (Ds2.isPresent(0x00, r)) "  <<<<<< VALID FRAME" else "",
                    ))
                } catch (e: Throwable) {
                    log("  $baud ${parity.name}: ${e.javaClass.simpleName}: ${e.message}")
                } finally {
                    runCatching { dev?.close() }
                }
            }
        }
        log("=== end vendor init replay ===")
    }

    /**
     * Drives every combination of the four CBUS pins and sends a DS2 identification request in
     * each, looking for the state in which the bus actually answers.
     *
     * This cable's EEPROM puts CBUS0-CBUS3 in IOMODE, which only makes sense if the host software
     * is supposed to drive them - and on a K-line adapter the likely job is enabling the
     * transceiver. Every measurement in this project so far was taken without touching them, so if
     * one of them is the bus driver's enable, all of it was taken with the driver switched off.
     * That would explain a line we can disturb but never talk on, and a car that is known to answer
     * other tools.
     */
    private fun cbusHunt(device: UsbDevice) {
        log("=== CBUS HUNT ===")
        log("EEPROM says CBUS0-3 are IOMODE, i.e. meant to be driven by software.")
        log("Trying all 16 output combinations with an identification request in each.")
        log("")

        val probes = listOf(0x00, 0x12, 0x16, 0x44, 0x56, 0x60, 0x80, 0xA0)
        var anyValid = false

        for (baud in listOf(9600, 10400)) {
            for (parity in listOf(FtdiDevice.Parity.EVEN, FtdiDevice.Parity.NONE)) {
                for (values in 0..15) {
                    if (stopRequested) { log("stopped"); return }
                    var dev: FtdiDevice? = null
                    try {
                        dev = FtdiDevice.open(usbManager, device, 0)
                        dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
                        // Reset clears the bit mode, so CBUS has to be driven after configure.
                        dev.setCbus(directions = 0x0F, values = values)
                        Thread.sleep(40)

                        val l = Ds2Link(dev)
                        var valid = 0
                        var sample = ""
                        var totalBytes = 0
                        for (addr in probes) {
                            val r = l.identify(addr, timeoutMs = 200)
                            totalBytes += r.raw.size
                            if (Ds2.isPresent(addr, r)) {
                                valid++
                                anyValid = true
                                sample = "0x%02X -> %s".format(addr, Ds2.hex(r.response!!))
                            } else if (sample.isEmpty() && r.raw.isNotEmpty()) {
                                sample = "0x%02X -> %s".format(addr, Ds2.hex(r.raw))
                            }
                        }
                        log("  %5d %-4s CBUS=%s  valid=%d bytes=%-3d %s".format(
                            baud, parity.name,
                            (3 downTo 0).joinToString("") { if (values shr it and 1 == 1) "1" else "0" },
                            valid, totalBytes,
                            if (valid > 0) "<<<<<< $sample" else sample.ifEmpty { "(silence)" },
                        ))
                    } catch (e: Throwable) {
                        log("  $baud ${parity.name} CBUS=$values: ${e.message}")
                    } finally {
                        runCatching { dev?.close() }
                    }
                }
            }
        }

        log("")
        if (anyValid) {
            log("A CBUS state produced a valid frame. That state is the cable's enable; set it")
            log("before every transaction from now on.")
        } else {
            log("No CBUS state produced a valid frame. Compare the byte counts: a state that")
            log("changes them is still doing something, even without a reply.")
        }
        log("=== end CBUS hunt ===")
    }

    /**
     * Tries every combination of the DTR and RTS outputs while sending a DS2 identification
     * request, at both candidate bit rates.
     *
     * On a K-line adapter these are not handshake lines. Cables commonly wire one of them to the
     * transceiver's enable, or to a selector between the K and L lines, and neither the USB
     * descriptors nor the EEPROM say which. This code has never set them, so they have been
     * wherever a chip reset left them for every measurement so far - which, if the transceiver
     * needs one asserted, is enough on its own to explain a line that we can pull down but that
     * never carries a usable signal.
     */
    private fun handshakeHunt(device: UsbDevice) {
        log("=== DTR / RTS HUNT ===")
        log("The cable may use one of these as a transceiver enable. Nothing so far has set them.")
        log("")

        val probes = listOf(0x00 to "DME-ish", 0x12 to "EGS-ish", 0x60 to "cluster-ish", 0x80 to "IHKA-ish")

        for (baud in listOf(9600, 10400)) {
            for (parity in listOf(FtdiDevice.Parity.EVEN, FtdiDevice.Parity.NONE)) {
                for (dtr in listOf(false, true)) {
                    for (rts in listOf(false, true)) {
                        if (stopRequested) { log("stopped"); return }
                        var dev: FtdiDevice? = null
                        try {
                            dev = FtdiDevice.open(usbManager, device, 0)
                            dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
                            dev.setModemControl(dtr, rts)
                            Thread.sleep(60)

                            val l = Ds2Link(dev)
                            var best = ""
                            var valid = 0
                            for ((addr, _) in probes) {
                                val r = l.identify(addr, timeoutMs = 250)
                                if (Ds2.isPresent(addr, r)) {
                                    valid++
                                    best = "0x%02X -> %s".format(addr, Ds2.hex(r.response!!))
                                } else if (best.isEmpty() && r.raw.isNotEmpty()) {
                                    best = "0x%02X -> %s".format(addr, Ds2.hex(r.raw))
                                }
                            }
                            log("  %5d %-4s DTR=%-5s RTS=%-5s  valid=%d  %s".format(
                                baud, parity.name, dtr.toString(), rts.toString(), valid,
                                if (valid > 0) "<<<<<< $best" else best.ifEmpty { "(silence)" },
                            ))
                        } catch (e: Throwable) {
                            log("  $baud ${parity.name} DTR=$dtr RTS=$rts: ${e.message}")
                        } finally {
                            runCatching { dev?.close() }
                        }
                    }
                }
            }
        }
        log("=== end DTR/RTS hunt ===")
    }

    /**
     * Drives square pulses of several widths onto the K-line and prints what comes back, sample by
     * sample, on the same timebase.
     *
     * Everything so far has been a decoder's opinion of the line. The baud hunt showed narrow
     * pulses vanishing while wide ones survive - 38400 with no parity goes silent while 38400 with
     * even parity, which has a two-bit low at the end of each frame, comes back - which is what a
     * slow edge looks like through a UART. This measures the edge directly instead of inferring it.
     *
     * A healthy K-line is pulled up hard by the bus and snaps back within a microsecond or two. A
     * line with no bus pull-up on it crawls back, and the crawl is visible here as a run of samples
     * where TXD has already been released but RXD is still low.
     */
    private fun pulseResponse(device: UsbDevice) {
        log("=== PULSE RESPONSE ===")
        log("Driving TXD low for a known number of samples and watching RXD recover.")
        log("  row 1 = TXD, what we drive.   row 2 = RXD, what the line does.")
        log("  '-' is high, '_' is low.")
        log("")

        var dev: FtdiDevice? = null
        try {
            dev = FtdiDevice.open(usbManager, device, 0)
            dev.configure(baudRate = Ds2.BAUD, parity = FtdiDevice.Parity.NONE, latencyMs = 1)

            // The bitbang clock is a multiple of the baud setting, and which multiple depends on
            // the chip and the driver path, so it is measured here rather than assumed: the
            // capture is timed and the sample period derived from it. Pulse widths are then
            // reported in microseconds, which is the only form in which "too short to matter" or
            // "far longer than a bit" actually means anything.
            // Fast enough that the shortest shapes below are comparable to a 9600-baud bit. At a
            // slower sample clock every pulse here is effectively DC, which a coupled path blocks,
            // and the test would answer a question nobody asked.
            val sampleBaud = 115200

            // Which pin actually drives the bus is an assumption, not a fact: DTR demonstrably
            // gates something in this cable, so TXD being the K-line driver needs checking rather
            // than taking on faith. Drive each candidate in turn and see which one RXD follows.
            val drivers = listOf(
                0x01 to "TXD",
                0x04 to "RTS",
                0x10 to "DTR",
            )

            // A single long pulse and a continuous square wave answer different questions. If the
            // path between the chip and the bus is AC coupled - a series capacitor somewhere - then
            // edges get through and steady levels do not, so a square wave appears on RXD while a
            // lone pulse vanishes. That distinction matters: it would explain both the garbled echo
            // and why every bit rate decodes to nonsense, and no protocol setting could fix it.
            val shapes = listOf(
                "pulse/64" to 64,
                "pulse/160" to 160,
                "square/8" to -8,
                "square/32" to -32,
            )

            for ((driverBit, driverName) in drivers) {
                for ((shapeName, shapeArg) in shapes) {
                    if (stopRequested) break
                val lead = 32
                val tail = 64
                // Hold every other output high; pull only the pin under test low.
                val idle = 0x01 or 0x04 or 0x10
                val low = idle and driverBit.inv()
                val body = if (shapeArg > 0) shapeArg else 192
                val wave = ByteArray(lead + body + tail) { i ->
                    when {
                        i < lead || i >= lead + body -> idle.toByte()
                        shapeArg > 0 -> low.toByte()
                        ((i - lead) / (-shapeArg / 2)) % 2 == 0 -> low.toByte()
                        else -> idle.toByte()
                    }
                }
                val lowWidth = if (shapeArg > 0) shapeArg else body

                val startedAt = System.nanoTime()
                val got = dev.syncBitbangCapture(wave, sampleBaud, driverMask = 0x01 or 0x04 or 0x10)
                val elapsedUs = (System.nanoTime() - startedAt) / 1000.0
                val usPerSample = if (got.isNotEmpty()) elapsedUs / got.size else 0.0
                if (got.isEmpty()) {
                    log("  $driverName $shapeName: capture returned nothing")
                    continue
                }

                val drv = StringBuilder()
                val rxd = StringBuilder()
                for (i in got.indices) {
                    drv.append(if (got[i].toInt() and driverBit != 0) '-' else '_')
                    rxd.append(if (got[i].toInt() and 0x02 != 0) '-' else '_')
                }

                val capturedDrvLow = got.count { it.toInt() and driverBit == 0 }
                val lowSamples = got.count { it.toInt() and 0x02 == 0 }

                log("  --- $driverName, $shapeName ---")
                log("  drv ${drv.take(130)}")
                log("  RXD ${rxd.take(130)}")

                // Without our own pulse visible in the capture, nothing can be concluded about the
                // line: a silent RXD row would mean a broken capture, not a quiet bus.
                if (capturedDrvLow == 0) {
                    log("  CAPTURE NOT TRUSTWORTHY: the $driverName pulse we drove is absent from")
                    log("  the samples, so RXD says nothing here.")
                } else {
                    val releaseAt = lead + lowWidth
                    var recovered = -1
                    for (i in releaseAt until got.size) {
                        if (got[i].toInt() and 0x02 != 0) { recovered = i; break }
                    }
                    log("  $driverName low in $capturedDrvLow samples, RXD low in $lowSamples; " +
                        when {
                            lowSamples == 0 -> "RXD did NOT follow"
                            recovered < 0 -> "RXD followed and never recovered in the capture"
                            else -> "RXD FOLLOWED, recovering ${recovered - releaseAt} samples after release"
                        })
                }
                    log("")
                }
            }
        } catch (e: Throwable) {
            log("  pulse response failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }
        log("=== end pulse response ===")
    }

    /**
     * Reports the resting logic level of the receive line, and whether anything is talking on it
     * when we stay silent.
     *
     * This separates two faults that look identical from byte values alone. A K-line that is
     * connected and idle sits steadily high, because the bus is pulled up and every node is
     * open-drain. An input wired to nothing drifts and flickers. The desk test proved the cable
     * invents nothing on its own, so if the level is unstable at the car, the receive line is not
     * attached to a working bus - and no amount of protocol tuning would ever have helped.
     *
     * The passive listen is the other half: if real modules are chattering on the bus we should
     * hear them without transmitting at all, and if we hear nothing while silent but garbage when
     * we talk, whatever comes back is a consequence of our own transmission.
     */
    private fun probeLineState(device: UsbDevice) {
        log("=== LINE STATE ===")
        var dev: FtdiDevice? = null
        try {
            dev = FtdiDevice.open(usbManager, device, 0)

            dev.rawDescriptors()?.let { d ->
                if (d.size >= 14) {
                    val bcd = (d[12].toInt() and 0xFF) or ((d[13].toInt() and 0xFF) shl 8)
                    log("  chip: bcdDevice=0x%04X  ->  %s".format(bcd, FtdiDevice.chipName(bcd)))
                }
            }

            dev.configure(baudRate = Ds2.BAUD, parity = FtdiDevice.Parity.EVEN, latencyMs = 1)

            log("  resting pin levels (bit1 = RXD), 200 samples while we stay silent:")
            reportPins(dev.samplePins(200))

            log("  pin levels sampled while transmitting:")
            Thread {
                repeat(40) {
                    runCatching { dev.write(byteArrayOf(0x55, 0x55, 0x55, 0x55), 200) }
                }
            }.start()
            Thread.sleep(30)
            reportPins(dev.samplePins(200))
            Thread.sleep(400)
            dev.purge()

            log("")
            log("  passive listen - no transmission at all:")
            for (baud in listOf(9600, 10400)) {
                dev.configure(baudRate = baud, parity = FtdiDevice.Parity.EVEN, latencyMs = 1)
                dev.purge()
                val heard = dev.readUntilQuiet(quietMs = 2000, overallTimeoutMs = 3000)
                log("    %5d baud, 3 s: %s".format(
                    baud,
                    if (heard.isEmpty()) "nothing - the bus is quiet while we are"
                    else "${heard.size} byte(s): ${Ds2.hex(heard.copyOfRange(0, minOf(32, heard.size)))}",
                ))
            }
        } catch (e: Throwable) {
            log("  line state probe failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }
        log("=== end line state ===")
    }

    private fun reportPins(dist: List<Pair<Int, Int>>) {
        if (dist.isEmpty()) {
            log("    chip refused the pin read")
            return
        }
        val total = dist.sumOf { it.second }
        for ((value, count) in dist.take(6)) {
            log("    0x%02X  %s  %d/%d  (%d%%)".format(
                value,
                (7 downTo 0).joinToString("") { if (value shr it and 1 == 1) "1" else "0" },
                count, total, count * 100 / total,
            ))
        }
        val rxdHigh = dist.filter { it.first and 0x02 != 0 }.sumOf { it.second }
        val pct = rxdHigh * 100 / total
        // Steady high on its own proves little: the chip's own pull-up holds an unconnected input
        // high too. The reading is a comparison, and the off-car control is 100% high at rest with
        // RXD never following our transmission.
        log("    RXD high in $pct% of samples - " + when {
            pct >= 98 -> "steady high (nothing is pulling it down)"
            pct <= 2 -> "steady low - a stuck or shorted line"
            else -> "UNSTABLE - what an unconnected, undriven input looks like"
        })
    }

    /**
     * Sweeps a wide range of baud rates looking for one where our own transmission comes back
     * unchanged.
     *
     * Field run 2 showed every reply starting with a byte that depends on the *baud setting* and
     * not on the data we sent - 0xC4 at 9600, 0xF4/0xFC at 10400 - with parity and framing errors
     * throughout, and the second byte tracking the low bit of the address. That is our own
     * transmission coming back sampled at the wrong bit rate, not a module replying.
     *
     * If the cable turns out to contain a microcontroller that talks at some fixed rate of its own,
     * then at that rate - and only at that rate - the echo will decode cleanly. That makes this a
     * direct test of the question the project has been stuck on, and it needs no car.
     */
    private fun baudHunt(device: UsbDevice, dtr: Boolean? = null, rts: Boolean? = null) {
        log("=== BAUD HUNT ===")
        log("Looking for a rate at which our own bytes come back unchanged.")
        log("A clean echo pins the cable's real bit rate; garbage everywhere means")
        log("whatever answers is not a UART running at any of these speeds.")
        log("")

        val pattern = byteArrayOf(0x55, 0x55, 0x55, 0x55)
        val bauds = listOf(
            1200, 2400, 4800, 9600, 10400, 14400, 19200, 28800,
            38400, 57600, 62500, 76800, 83333, 115200, 125000, 230400,
        )
        var cleanFound = false
        var allSilent = true

        for (baud in bauds) {
            for (parity in listOf(FtdiDevice.Parity.NONE, FtdiDevice.Parity.EVEN)) {
                if (stopRequested) { log("stopped"); return }
                var dev: FtdiDevice? = null
                try {
                    dev = FtdiDevice.open(usbManager, device, 0)
                    dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
                    if (dtr != null || rts != null) {
                        dev.setModemControl(dtr, rts)
                        Thread.sleep(40)
                    }
                    dev.purge()
                    dev.write(pattern)
                    val rx = dev.readUntilQuiet(quietMs = 60, overallTimeoutMs = 500)
                    val clean = rx.contentEquals(pattern)
                    if (clean) cleanFound = true
                    if (rx.isNotEmpty()) allSilent = false
                    log("  %6d %-4s  RX %-26s %s".format(
                        baud, parity.name,
                        if (rx.isEmpty()) "(silence)" else Ds2.hex(rx),
                        if (clean) "<<<<<< CLEAN ECHO" else "",
                    ))
                } catch (e: Throwable) {
                    log("  %6d %-4s  error: %s".format(baud, parity.name, e.message))
                } finally {
                    runCatching { dev?.close() }
                }
            }
        }

        log("")
        when {
            cleanFound -> {
                log("A clean echo means the serial path works at that rate - use it as the")
                log("cable's real bit rate and retry DS2 framing there.")
            }
            allSilent -> {
                log("Silence at every rate. The cable invents nothing on its own, which is")
                log("correct behaviour with nothing to receive. Off the car this is the")
                log("expected result and proves there is no internal echo or crosstalk.")
                log("On the car it would instead mean the receive line is dead.")
            }
            else -> {
                log("Bytes came back but never matched what we sent, at any rate. Whatever")
                log("drives the receive line is not a UART at a standard speed.")
            }
        }
        log("=== end baud hunt ===")
    }

    /**
     * Sends known byte patterns and reports character for character what comes back.
     *
     * The first field run established that bytes return but no frame parses, which leaves several
     * very different explanations - a clean hardware echo, a corrupted echo, or a real reply landing
     * on top of one. A byte count cannot separate those; a known pattern can. 0x55 and 0xAA are
     * chosen because they are alternating bit patterns, so a baud or parity mismatch mangles them
     * in an obvious and recognisable way rather than subtly.
     */
    private fun characteriseLine(device: UsbDevice) {
        log("=== LINE CHARACTERISATION ===")
        log("Sending fixed patterns; RX is printed exactly as received.")
        log("  '=TX' means the hardware echoed our transmission back unchanged,")
        log("  which is normal and expected on a single-wire K-line.")
        log("")

        val patterns = listOf(
            byteArrayOf(0x55, 0x55, 0x55, 0x55),
            byteArrayOf(0xAA.toByte(), 0xAA.toByte()),
            byteArrayOf(0x00),
            byteArrayOf(0xFF.toByte()),
            Ds2.frame(0x80, byteArrayOf(0x00)),
        )

        for (baud in listOf(9600, 10400)) {
            for (parity in listOf(FtdiDevice.Parity.EVEN, FtdiDevice.Parity.NONE)) {
                if (stopRequested) return
                var dev: FtdiDevice? = null
                try {
                    dev = FtdiDevice.open(usbManager, device, 0)
                    dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
                    for (tx in patterns) {
                        if (stopRequested) break
                        dev.purge()
                        dev.write(tx)
                        val rx = dev.readUntilQuiet(quietMs = 80, overallTimeoutMs = 700)
                        val verdict = when {
                            rx.isEmpty() -> "NO ECHO - nothing came back at all"
                            rx.contentEquals(tx) -> "=TX  exact echo"
                            rx.size == tx.size -> "same length, different bytes"
                            rx.size > tx.size -> "LONGER than TX - ${rx.size - tx.size} extra byte(s)"
                            else -> "shorter than TX"
                        }
                        val ls = dev.lastLineStatus
                        log("  %5d %-4s TX %-14s RX %-26s %s%s".format(
                            baud, parity.name, Ds2.hex(tx),
                            if (rx.isEmpty()) "(silence)" else Ds2.hex(rx),
                            verdict,
                            if (ls and 0x0E != 0) "  LINE=0x%02X".format(ls) else "",
                        ))
                    }
                } catch (e: Throwable) {
                    log("  $baud ${parity.name}: ${e.javaClass.simpleName}: ${e.message}")
                } finally {
                    runCatching { dev?.close() }
                }
            }
        }
        log("=== end line characterisation ===")
    }

    /**
     * Walks all 256 addresses in one configuration, printing every address that returns anything
     * other than a plain echo of the request.
     */
    private fun fullScan(device: UsbDevice, baud: Int, parity: FtdiDevice.Parity) {
        log("=== FULL 256-ADDRESS SCAN ===")
        log("  $baud baud, ${parity.name} parity")
        log("  only addresses that answer with something other than our own bytes are printed")

        var dev: FtdiDevice? = null
        try {
            dev = FtdiDevice.open(usbManager, device, 0)
            dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
            val l = Ds2Link(dev)
            var interesting = 0
            val hits = l.scanBus(timeoutMs = 180, shouldStop = { stopRequested }) { addr, r ->
                val isPlainEcho = r.raw.contentEquals(r.request)
                if (r.raw.isNotEmpty() && !isPlainEcho) {
                    interesting++
                    log("   0x%02X RX %s%s%s".format(
                        addr, Ds2.hex(r.raw),
                        if (Ds2.isPresent(addr, r)) "  <<< VALID FRAME" else "",
                        describeTrouble(r),
                    ))
                }
            }
            log("=== scan done: ${hits.size} valid frame(s), $interesting non-echo response(s) ===")
            hits.forEach { (addr, r) ->
                log("MODULE AT 0x%02X  (%s)".format(addr, Ds2.KnownEcu[addr] ?: "address not in our guess table"))
                log(r.describe())
            }
        } catch (e: Throwable) {
            log("full scan failed: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            runCatching { dev?.close() }
        }
    }

    private fun runSweep(device: UsbDevice): SweepBest? {
        run {
            data class Outcome(
                val baud: Int, val parity: FtdiDevice.Parity,
                val valid: Int, val bytesBack: Int, val beyondEcho: Int,
            )

            val probeAddresses = Ds2.KnownEcu.keys.toList()
            val results = ArrayList<Outcome>()

            log("=== AUTO-SWEEP ===")
            log("probing ${probeAddresses.size} candidate addresses per configuration")
            log("echo is detected per transaction now, so it is no longer a dimension to sweep")
            log("")

            outer@ for (baud in listOf(9600, 10400)) {
                for (parity in listOf(FtdiDevice.Parity.EVEN, FtdiDevice.Parity.NONE)) {
                    if (stopRequested) break@outer

                    var dev: FtdiDevice? = null
                    try {
                        dev = FtdiDevice.open(usbManager, device, 0)
                        dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
                    } catch (e: Throwable) {
                        log("$baud ${parity.name}: cannot open - ${e.message}")
                        runCatching { dev?.close() }
                        continue
                    }

                    try {
                        val l = Ds2Link(dev)
                        var valid = 0
                        var bytes = 0
                        var beyondEcho = 0
                        log("--- $baud baud, ${parity.name} parity ---")
                        for (addr in probeAddresses) {
                            if (stopRequested) break
                            val r = l.identify(addr, timeoutMs = 250)
                            bytes += r.raw.size
                            // Bytes that are not simply our own transmission coming back. A clean
                            // echo is self-consistent at any baud, so it tells us nothing about the
                            // car; only the surplus is evidence that something else is talking.
                            beyondEcho += r.raw.size - (if (r.echoOffset >= 0) r.request.size else 0)
                            if (Ds2.isPresent(addr, r)) valid++

                            // Log the actual bytes, not just a count. The first field run reported
                            // "bytes did come back" without saying what they were, which is exactly
                            // the thing needed to tell an echo from a reply.
                            log("   0x%02X TX %s  RX %s%s%s".format(
                                addr,
                                Ds2.hex(r.request),
                                if (r.raw.isEmpty()) "(silence)" else Ds2.hex(r.raw),
                                if (r.raw.contentEquals(r.request)) "  =TX exactly" else "",
                                if (Ds2.isPresent(addr, r)) "  <<< VALID FRAME" else "",
                            ))
                            if (r.note.isNotEmpty() || r.lineStatus and 0x0E != 0) {
                                log("        ${r.note}${describeTrouble(r)}")
                            }
                        }
                        results.add(Outcome(baud, parity, valid, bytes, beyondEcho))
                        log("  => %5d %-4s  valid=%d  total=%d  beyond-echo=%d".format(
                            baud, parity.name, valid, bytes, beyondEcho))
                        log("")
                    } finally {
                        runCatching { dev.close() }
                    }
                }
            }

            log("")
            log("=== AUTO-SWEEP RESULT ===")
            // Rank by valid frames, then by bytes that were not just our own echo.
            val best = results.maxByOrNull { it.valid * 1_000_000 + it.beyondEcho * 100 + it.bytesBack }
            when {
                best == null -> log("nothing ran")
                best.valid > 0 -> {
                    log("WORKING CONFIGURATION FOUND:")
                    log("  ${best.baud} baud, ${best.parity.name} parity")
                    log("  ${best.valid} module(s) answered")
                }
                best.beyondEcho > 0 -> {
                    log("No valid frame, but something beyond our own echo came back.")
                    log("  best: ${best.baud} baud, ${best.parity.name} parity, " +
                        "${best.beyondEcho} byte(s) beyond echo")
                    log("Those surplus bytes are the interesting ones - read the RX lines above.")
                }
                best.bytesBack > 0 -> {
                    log("Only our own transmission came back, in every configuration.")
                    log("The cable echoes and nothing on the bus replies. Since a clean echo is")
                    log("self-consistent at any baud, this result does not discriminate between")
                    log("settings - it says the car is not answering DS2 identification at all.")
                }
                else -> {
                    log("Total silence in every configuration - not even an echo.")
                    log("Check first: ignition in position 2, cable seated in the OBD socket.")
                }
            }
            log("=== end auto-sweep ===")

            return if (best != null) SweepBest(best.baud, best.parity, best.valid) else null
        }
    }

    /** The configuration the sweep liked best, handed to the full scan. */
    private data class SweepBest(
        val baud: Int,
        val parity: FtdiDevice.Parity,
        val valid: Int,
    )

    private fun scanBus() {
        stopRequested = false
        withLink("scan") { l ->
            log("=== bus scan: identification request to every address 0x00..0xFF ===")
            log("this takes a while; silent addresses are normal. Stop button aborts.")
            var answered = 0
            val hits = l.scanBus(shouldStop = { stopRequested }) { addr, r ->
                if (r.raw.isNotEmpty() && !r.raw.contentEquals(r.request)) {
                    answered++
                    log("0x%02X -> %s".format(addr, Ds2.hex(r.raw)))
                }
            }
            log("=== scan done: ${hits.size} valid frame(s), $answered address(es) made noise ===")
            hits.forEach { (addr, r) ->
                val guess = Ds2.KnownEcu[addr] ?: "unknown address"
                log("0x%02X  %s".format(addr, guess))
                log(r.describe())
            }
            if (hits.isEmpty()) {
                log("No module answered. Before concluding the cable needs its own protocol, try:")
                log("  1. ignition in position 2 (KL.15 on) - most modules sleep otherwise")
                log("  2. the other parity setting (8N1 instead of 8E1)")
                log("  3. toggling the echo checkbox")
                log("  4. Channel B instead of Channel A")
            }
        }
    }

    private fun dumpEeprom() {
        val dev = ftdi ?: run { log("EEPROM: not connected"); return }
        io.launch { dumpEepromInto(dev) }
    }

    private fun dumpEepromInto(dev: FtdiDevice) {
        run {
            log("=== FTDI EEPROM dump (words 0x00..0x3F) ===")
            val words = dev.dumpEeprom(64)
            for (base in words.indices step 8) {
                val line = (base until minOf(base + 8, words.size)).joinToString(" ") { i ->
                    if (words[i] < 0) "----" else "%04X".format(words[i])
                }
                log("  %02X: %s".format(base, line))
            }
            // Word 1 / 2 hold the flashed VID / PID on the classic FTDI layout.
            if (words.size > 2 && words[1] >= 0 && words[2] >= 0) {
                log("  EEPROM VID=0x%04X PID=0x%04X".format(words[1], words[2]))
            }
            if (words.all { it < 0 }) {
                log("  chip refused every EEPROM read (not fatal - serial IO can still work)")
            }
            log("=== end EEPROM dump ===")
        }
    }

    private fun describeDevices() {
        log("=== USB descriptors ===")
        for (d in devices) {
            log("device ${d.deviceName}  VID=%04X PID=%04X".format(d.vendorId, d.productId))
            log("  manufacturer=${d.manufacturerName}  product=${d.productName}")
            log("  serial=" + runCatching {
                if (usbManager.hasPermission(d)) d.serialNumber else "(needs permission)"
            }.getOrElse { "(unreadable)" })
            log("  class=${d.deviceClass} subclass=${d.deviceSubclass} protocol=${d.deviceProtocol}")
            log("  interfaces=${d.interfaceCount}" +
                if (d.interfaceCount > 1) "  -> dual-channel part (FT2232-like)" else "")
            for (i in 0 until d.interfaceCount) {
                val f = d.getInterface(i)
                log("  iface#${f.id} class=${f.interfaceClass} endpoints=${f.endpointCount}")
                for (j in 0 until f.endpointCount) {
                    val ep = f.getEndpoint(j)
                    val dir = if (ep.direction == UsbConstants.USB_DIR_IN) "IN " else "OUT"
                    val type = when (ep.type) {
                        UsbConstants.USB_ENDPOINT_XFER_BULK -> "bulk"
                        UsbConstants.USB_ENDPOINT_XFER_INT -> "intr"
                        UsbConstants.USB_ENDPOINT_XFER_ISOC -> "isoc"
                        else -> "ctrl"
                    }
                    log("      ep 0x%02X %s %s maxPacket=%d".format(
                        ep.address, dir, type, ep.maxPacketSize))
                }
            }
        }
        log("=== end descriptors ===")
    }

    // ------------------------------------------------------------------ log export

    private fun logText() = synchronized(logBuffer) { logBuffer.toString() }

    private fun saveLog() {
        io.launch { saveLogNow() }
    }

    private fun saveLogNow() {
        try {
            val dir = getExternalFilesDir(null) ?: filesDir
            val name = "ds2probe-" +
                SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date()) + ".log"
            val f = File(dir, name)
            f.writeText(logText())
            log("log saved: ${f.absolutePath}")
        } catch (e: Throwable) {
            log("save FAILED: ${e.message}")
        }
    }

    private fun shareLog() {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "BMW DS2 probe log")
            putExtra(Intent.EXTRA_TEXT, logText())
        }
        startActivity(Intent.createChooser(send, "Share log"))
    }
}

/** Kept separate so the version string does not depend on the generated BuildConfig class. */
private object BuildConfigVersion {
    const val NAME = "0.20-probe"
}
