package hu.bmwscanner.usb

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import java.io.Closeable
import java.io.IOException

/**
 * Raw-USB driver for the FTDI chip inside the BMW Scanner 1.4.0 cable.
 *
 * The cable enumerates as VID 0x0333 / PID 0x0137 ("PASOFT" / "BMW Scanner V14x") because its
 * FTDI EEPROM was re-flashed with a non-FTDI vendor id; the shipped Windows driver is plain
 * FTD2XX 3.01.02 bound to that id (see docs/findings.md). We talk the FTDI vendor-request
 * interface directly rather than depending on usb-serial-for-android, because:
 *
 *  - the vendor id is non-standard, so stock probe tables will not match it;
 *  - the shipped INF declares "Channel A"/"Channel B" interfaces, i.e. the part may be a
 *    dual-channel FT2232, which needs an explicit port index in every control request;
 *  - the DS2 K-line work needs the per-packet line-status byte (parity/framing errors) and a
 *    1 ms latency timer, neither of which is reliably exposed by the wrapper libraries.
 */
class FtdiDevice private constructor(
    private val connection: UsbDeviceConnection,
    private val iface: UsbInterface,
    private val epIn: UsbEndpoint,
    private val epOut: UsbEndpoint,
    /** wIndex port selector: 0 on single-channel parts, 1 = channel A / 2 = channel B on FT2232. */
    private val portIndex: Int,
    private val multiChannel: Boolean,
) : Closeable {

    val maxPacketSize: Int = epIn.maxPacketSize.coerceAtLeast(64)

    /** Modem-status byte from the most recent IN packet (bit4 CTS, bit5 DSR, bit6 RI, bit7 RLSD). */
    @Volatile
    var lastModemStatus: Int = 0
        private set

    /**
     * Line-status byte from the most recent IN packet. Bit1 overrun, bit2 parity error,
     * bit3 framing error, bit4 break. On a K-line these flag a wrong parity or baud guess.
     */
    @Volatile
    var lastLineStatus: Int = 0
        private set

    private val rawBuf = ByteArray(maxPacketSize * 16)
    private val pending = ArrayDeque<Byte>()

    // ---------------------------------------------------------------- configuration

    enum class Parity(val code: Int) { NONE(0), ODD(1), EVEN(2), MARK(3), SPACE(4) }
    enum class StopBits(val code: Int) { ONE(0), ONE_POINT_FIVE(1), TWO(2) }

    /**
     * Resets the chip, applies the line settings and drops the latency timer.
     *
     * @param latencyMs how long the chip buffers a partial packet before sending it up. The FTDI
     *   default is 16 ms, which would smear DS2 inter-byte timing; 1 ms is the minimum.
     */
    fun configure(
        baudRate: Int,
        parity: Parity,
        dataBits: Int = 8,
        stopBits: StopBits = StopBits.ONE,
        latencyMs: Int = 1,
    ) {
        require(dataBits in 7..8) { "FTDI supports 7 or 8 data bits, got $dataBits" }

        control(SIO_RESET, SIO_RESET_SIO, portIndex)
        setFlowControl(FLOW_NONE)
        setBaudRate(baudRate)
        setLineProperties(dataBits, parity, stopBits)
        setLatencyTimer(latencyMs)
        purge()
    }

    fun setBaudRate(baudRate: Int) {
        val (value, divisorHigh) = encodeBaudDivisor(baudRate)
        val index = if (multiChannel) (divisorHigh shl 8) or portIndex else divisorHigh
        control(SIO_SET_BAUD_RATE, value, index)
    }

    fun setLineProperties(dataBits: Int, parity: Parity, stopBits: StopBits) {
        val value = dataBits or (parity.code shl 8) or (stopBits.code shl 11)
        control(SIO_SET_DATA, value, portIndex)
    }

    fun setLatencyTimer(ms: Int) =
        control(SIO_SET_LATENCY_TIMER, ms.coerceIn(1, 255), portIndex)

    fun setFlowControl(mode: Int) =
        control(SIO_SET_FLOW_CTRL, 0, mode or portIndex)

    /** Drops whatever is sitting in the chip's RX and TX FIFOs and in our own de-framed queue. */
    fun purge() {
        control(SIO_RESET, SIO_RESET_PURGE_RX, portIndex)
        control(SIO_RESET, SIO_RESET_PURGE_TX, portIndex)
        pending.clear()
    }

    /**
     * Asserts or releases a transmit break. Needed if a module turns out to want the classic
     * 5-baud / break-based wake-up rather than plain DS2 framing.
     */
    fun setBreak(on: Boolean, dataBits: Int, parity: Parity, stopBits: StopBits) {
        var value = dataBits or (parity.code shl 8) or (stopBits.code shl 11)
        if (on) value = value or (1 shl 14)
        control(SIO_SET_DATA, value, portIndex)
    }

    // ---------------------------------------------------------------- data transfer

    fun write(data: ByteArray, timeoutMs: Int = 2000) {
        var off = 0
        while (off < data.size) {
            val chunk = minOf(data.size - off, maxPacketSize)
            // bulkTransfer has no offset parameter on API 21, so copy each chunk out.
            val slice = data.copyOfRange(off, off + chunk)
            val n = connection.bulkTransfer(epOut, slice, slice.size, timeoutMs)
            if (n < 0) throw IOException("USB bulk OUT failed at offset $off of ${data.size}")
            off += n
        }
    }

    /**
     * Performs one bulk IN transfer and appends the payload to [pending], stripping the two
     * status bytes that FTDI prefixes to *every* packet of up to [maxPacketSize] bytes.
     *
     * @return number of payload bytes produced, or -1 if the transfer failed or timed out.
     */
    private fun pump(timeoutMs: Int): Int {
        val n = connection.bulkTransfer(epIn, rawBuf, rawBuf.size, timeoutMs)
        if (n < 0) return -1
        var off = 0
        var produced = 0
        while (off + 2 <= n) {
            val packet = minOf(maxPacketSize, n - off)
            lastModemStatus = rawBuf[off].toInt() and 0xFF
            lastLineStatus = rawBuf[off + 1].toInt() and 0xFF
            for (i in (off + 2) until (off + packet)) {
                pending.addLast(rawBuf[i])
                produced++
            }
            off += packet
        }
        return produced
    }

    /** Reads exactly [count] bytes, or fewer if [timeoutMs] elapses first. */
    fun readBytes(count: Int, timeoutMs: Int): ByteArray {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (pending.size < count) {
            val left = (deadline - System.currentTimeMillis()).toInt()
            if (left <= 0) break
            pump(left.coerceAtMost(40))
        }
        val n = minOf(count, pending.size)
        return ByteArray(n) { pending.removeFirst() }
    }

    /**
     * Reads until the line has been quiet for [quietMs], giving up after [overallTimeoutMs].
     * Used when the reply length is not yet known - i.e. while the protocol is still unmapped.
     */
    fun readUntilQuiet(quietMs: Int = 60, overallTimeoutMs: Int = 1200): ByteArray {
        val out = ArrayList<Byte>()
        val deadline = System.currentTimeMillis() + overallTimeoutMs
        var lastData = System.currentTimeMillis()
        while (System.currentTimeMillis() < deadline) {
            while (pending.isNotEmpty()) {
                out.add(pending.removeFirst())
                lastData = System.currentTimeMillis()
            }
            if (out.isNotEmpty() && System.currentTimeMillis() - lastData >= quietMs) break
            if (pump(20) > 0) lastData = System.currentTimeMillis()
        }
        while (pending.isNotEmpty()) out.add(pending.removeFirst())
        return out.toByteArray()
    }

    // ---------------------------------------------------------------- EEPROM

    /**
     * Reads one 16-bit word from the chip's configuration EEPROM.
     *
     * This is how we learn what the cable actually is - the EEPROM holds the VID/PID that was
     * flashed over the FTDI defaults plus the manufacturer / product / serial strings, and its
     * layout differs between FT232BM and FT2232. Returns null if the chip refuses the request.
     */
    fun readEepromWord(wordAddress: Int): Int? {
        val buf = ByteArray(2)
        val n = connection.controlTransfer(
            REQ_TYPE_IN, SIO_READ_EEPROM, 0, wordAddress, buf, 2, 1000,
        )
        if (n != 2) return null
        return (buf[0].toInt() and 0xFF) or ((buf[1].toInt() and 0xFF) shl 8)
    }

    fun dumpEeprom(words: Int = 64): IntArray =
        IntArray(words) { readEepromWord(it) ?: -1 }

    // ---------------------------------------------------------------- plumbing

    private fun control(request: Int, value: Int, index: Int) {
        val n = connection.controlTransfer(REQ_TYPE_OUT, request, value, index, null, 0, 2000)
        if (n < 0) {
            throw IOException(
                "FTDI control request 0x%02X (value=0x%04X index=0x%04X) failed".format(request, value, index),
            )
        }
    }

    override fun close() {
        runCatching { connection.releaseInterface(iface) }
        runCatching { connection.close() }
    }

    companion object {
        /** VID/PID the BMW Scanner 1.4.0 cable reports. */
        const val BMW_SCANNER_VID = 0x0333
        const val BMW_SCANNER_PID = 0x0137
        const val FTDI_VID = 0x0403

        private val REQ_TYPE_OUT = UsbConstants.USB_TYPE_VENDOR or UsbConstants.USB_DIR_OUT // 0x40
        private val REQ_TYPE_IN = UsbConstants.USB_TYPE_VENDOR or UsbConstants.USB_DIR_IN   // 0xC0

        private const val SIO_RESET = 0x00
        private const val SIO_SET_FLOW_CTRL = 0x02
        private const val SIO_SET_BAUD_RATE = 0x03
        private const val SIO_SET_DATA = 0x04
        private const val SIO_SET_LATENCY_TIMER = 0x09
        private const val SIO_READ_EEPROM = 0x90

        private const val SIO_RESET_SIO = 0
        private const val SIO_RESET_PURGE_RX = 1
        private const val SIO_RESET_PURGE_TX = 2

        const val FLOW_NONE = 0x0000
        const val FLOW_RTS_CTS = 0x0100
        const val FLOW_DTR_DSR = 0x0200
        const val FLOW_XON_XOFF = 0x0400

        /** Candidate cables, most specific first. */
        fun candidates(manager: UsbManager): List<UsbDevice> =
            manager.deviceList.values.sortedBy {
                when {
                    it.vendorId == BMW_SCANNER_VID && it.productId == BMW_SCANNER_PID -> 0
                    it.vendorId == FTDI_VID -> 1
                    else -> 2
                }
            }

        /**
         * Claims [channel] of [device] (0 = A, 1 = B) and returns a configured-but-not-yet-opened
         * driver. Caller must already hold USB permission for the device.
         */
        fun open(manager: UsbManager, device: UsbDevice, channel: Int = 0): FtdiDevice {
            val connection = manager.openDevice(device)
                ?: throw IOException("openDevice failed - USB permission not granted?")

            try {
                val multiChannel = device.interfaceCount > 1
                if (channel >= device.interfaceCount) {
                    throw IOException(
                        "channel $channel requested but the device exposes only " +
                            "${device.interfaceCount} interface(s)",
                    )
                }
                val iface = device.getInterface(channel)
                if (!connection.claimInterface(iface, true)) {
                    throw IOException("claimInterface(${iface.id}) failed - is another app holding it?")
                }

                var epIn: UsbEndpoint? = null
                var epOut: UsbEndpoint? = null
                for (i in 0 until iface.endpointCount) {
                    val ep = iface.getEndpoint(i)
                    if (ep.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
                    if (ep.direction == UsbConstants.USB_DIR_IN) {
                        if (epIn == null) epIn = ep
                    } else {
                        if (epOut == null) epOut = ep
                    }
                }
                if (epIn == null || epOut == null) {
                    throw IOException("interface ${iface.id} has no bulk IN/OUT endpoint pair")
                }

                // FTDI numbers ports from 1 on multi-channel parts; single-channel parts use 0.
                val portIndex = if (multiChannel) iface.id + 1 else 0
                return FtdiDevice(connection, iface, epIn, epOut, portIndex, multiChannel)
            } catch (e: Throwable) {
                connection.close()
                throw e
            }
        }

        /**
         * Encodes [baudRate] into the FTDI divisor pair (wValue, high bits for wIndex).
         *
         * FTDI parts after the original FT8U232AM divide a 3 MHz clock by an integer plus one of
         * eight fractional steps; the fractional step is not stored linearly but through a lookup.
         */
        fun encodeBaudDivisor(baudRate: Int): Pair<Int, Int> {
            require(baudRate in 184..3_000_000) { "baud rate $baudRate out of FTDI range" }
            val fracCode = intArrayOf(0, 3, 2, 4, 1, 5, 6, 7)

            // Divisor expressed in eighths, rounded to nearest.
            val eighths = (8 * 3_000_000 + baudRate / 2) / baudRate
            var divisor = (eighths / 8) or (fracCode[eighths % 8] shl 14)

            // Two encodings are special-cased by the hardware.
            if (divisor == 1) divisor = 0           // 3 MHz
            else if (divisor == 0x4001) divisor = 1 // 2 MHz

            return Pair(divisor and 0xFFFF, (divisor shr 16) and 0xFF)
        }
    }
}
