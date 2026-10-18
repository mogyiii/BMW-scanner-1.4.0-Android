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
                log("    no cable present"); return
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
                "baudhunt" -> { stopRequested = false; io.launch { baudHunt(device!!) } }
                "chars" -> { stopRequested = false; io.launch { characteriseLine(device!!) } }
                "sweep" -> { stopRequested = false; io.launch { runSweep(device!!) } }
                "scan" -> { stopRequested = false; io.launch { fullScan(device!!, baud, parity) } }
                "send" -> {
                    val hex = intent.getStringExtra("hex") ?: run { log("    need --es hex"); return }
                    stopRequested = false
                    io.launch { sendOnce(device!!, baud, parity, hex) }
                }
                else -> log("    unknown command")
            }
        }
    }

    /** The BMW cable if present, else any FTDI-looking device, else null. */
    private fun cableDevice(): UsbDevice? {
        devices = FtdiDevice.candidates(usbManager)
        return devices.firstOrNull {
            it.vendorId == FtdiDevice.BMW_SCANNER_VID && it.productId == FtdiDevice.BMW_SCANNER_PID
        } ?: devices.firstOrNull { it.vendorId == FtdiDevice.FTDI_VID }
    }

    /** One-shot: open, send the given hex, print everything that comes back, close. */
    private fun sendOnce(device: UsbDevice, baud: Int, parity: FtdiDevice.Parity, hex: String) {
        var dev: FtdiDevice? = null
        try {
            val tx = Ds2.parseHex(hex)
            dev = FtdiDevice.open(usbManager, device, 0)
            dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
            dev.purge()
            dev.write(tx)
            val rx = dev.readUntilQuiet(quietMs = 80, overallTimeoutMs = 900)
            log("  $baud ${parity.name}  TX ${Ds2.hex(tx)}")
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

                // Step 3 - is there any bit rate at which the line behaves like a UART at all.
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
    private fun baudHunt(device: UsbDevice) {
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

        for (baud in bauds) {
            for (parity in listOf(FtdiDevice.Parity.NONE, FtdiDevice.Parity.EVEN)) {
                if (stopRequested) { log("stopped"); return }
                var dev: FtdiDevice? = null
                try {
                    dev = FtdiDevice.open(usbManager, device, 0)
                    dev.configure(baudRate = baud, parity = parity, latencyMs = 1)
                    dev.purge()
                    dev.write(pattern)
                    val rx = dev.readUntilQuiet(quietMs = 60, overallTimeoutMs = 500)
                    val clean = rx.contentEquals(pattern)
                    if (clean) cleanFound = true
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
        if (cleanFound) {
            log("A clean echo means the serial path works at that rate - use it as the")
            log("cable's real bit rate and retry DS2 framing there.")
        } else {
            log("No rate produced a clean echo. Whatever is feeding the receive line is")
            log("not a UART at any standard speed, which points away from a plain")
            log("FTDI-plus-transceiver cable.")
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
    const val NAME = "0.5-probe"
}
