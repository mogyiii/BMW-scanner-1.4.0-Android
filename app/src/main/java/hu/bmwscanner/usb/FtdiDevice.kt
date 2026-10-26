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

    /**
     * Drives the DTR and RTS handshake outputs.
     *
     * These are not handshake lines on a K-line adapter. Interface cables routinely wire one of
     * them to the transceiver's enable or to a K/L line selector, and nothing in the USB or EEPROM
     * descriptors reveals which. Until now this code never touched them, so they have been sitting
     * wherever a chip reset left them - which, if the transceiver needs one asserted, would leave
     * the bus driver switched off and produce exactly the half-working line we have been chasing.
     */
    fun setModemControl(dtr: Boolean?, rts: Boolean?) {
        if (dtr != null) control(SIO_MODEM_CTRL, if (dtr) 0x0101 else 0x0100, portIndex)
        if (rts != null) control(SIO_MODEM_CTRL, if (rts) 0x0202 else 0x0200, portIndex)
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

    /**
     * Collects everything that arrives over a fixed [windowMs], tagging each batch with how long
     * after the call it turned up. Never returns early.
     *
     * [readUntilQuiet] cannot be used to look for a late reply, and that blind spot shaped most of
     * this project. It stops once the line has been quiet for a moment, and on this cable the first
     * thing to arrive is always the transmission artefact — so every read has been ending a few tens
     * of milliseconds after transmission, and anything arriving later was invisible. A device that
     * needs to boot, or a protocol that permits a response-pending reply, answers far outside that
     * window.
     *
     * The timestamps are what make the result interpretable: the artefact is immediate and fixed in
     * duration, so bytes separated from it in time are a different phenomenon whatever they contain.
     */
    fun readTimed(windowMs: Int): List<Pair<Long, ByteArray>> {
        val out = ArrayList<Pair<Long, ByteArray>>()
        val start = System.currentTimeMillis()
        val deadline = start + windowMs
        while (System.currentTimeMillis() < deadline) {
            pump(20)
            if (pending.isEmpty()) continue
            val at = System.currentTimeMillis() - start
            val chunk = ByteArray(pending.size) { pending.removeFirst() }
            out.add(at to chunk)
        }
        if (pending.isNotEmpty()) {
            val at = System.currentTimeMillis() - start
            out.add(at to ByteArray(pending.size) { pending.removeFirst() })
        }
        return out
    }

    // ---------------------------------------------------------------- CBUS GPIO

    /**
     * Drives the FT232R's CBUS pins as GPIO while the UART keeps running.
     *
     * This cable's EEPROM configures CBUS0 through CBUS3 as IOMODE - bytes 0x14/0x15 read 0xAA,
     * and 0xA is the FT232R's code for CBUS bit-bang. A plain USB-serial adapter has no reason to
     * do that: those pins are only in IOMODE if the host software is expected to drive them. On a
     * K-line adapter the obvious candidates are the transceiver's enable or a direction control,
     * which would mean nothing we have measured so far was taken with the bus driver switched on.
     *
     * @param directions bit per pin, CBUS0 in bit 0; 1 makes that pin an output
     * @param values bit per pin, the level to drive on pins that are outputs
     */
    fun setCbus(directions: Int, values: Int) =
        setBitMode(((directions and 0x0F) shl 4) or (values and 0x0F), BITMODE_CBUS)

    /** In CBUS mode the pin read returns the four CBUS levels in the low nibble. */
    fun readCbus(): Int? = readPins()?.and(0x0F)

    // ---------------------------------------------------------------- bitbang capture

    fun setBitMode(pinMask: Int, mode: Int) =
        control(SIO_SET_BITMODE, ((mode and 0xFF) shl 8) or (pinMask and 0xFF), portIndex)

    /**
     * Drives TXD from [outLevels] and samples every pin at the same clock, one sample per byte
     * written. Returns the captured samples.
     *
     * Synchronous bitbang is the only way to see what the line actually *does*. In normal UART mode
     * transmit and receive share one baud setting, so a signal whose edges are being smeared can
     * only ever be observed through a decoder that is itself confused by the smearing. Here we
     * drive a known square pulse and watch the response on the same timebase, which turns a
     * question about protocol settings into a measurement of rise time.
     *
     * Bit 0 of each byte is TXD (driven), bit 1 is RXD (sampled).
     *
     * Two caveats, both measured after this was written and both reasons to prefer
     * [syncBitbangStream] for anything timing-sensitive: [sampleBaud] is not the sample rate (the
     * bitbang clock runs about four times faster - see [syncBitbangStream]), and the write/read
     * ping-pong below cannot feed the chip fast enough at these rates, so the clock stalls and the
     * samples either side of a gap are not a fixed time apart. The two callers left on this path
     * use it to see *whether* the line moves, not to time anything.
     */
    fun syncBitbangCapture(
        outLevels: ByteArray,
        sampleBaud: Int,
        driverMask: Int = 0x01,
    ): ByteArray {
        setBaudRate(sampleBaud)
        purge()
        setBitMode(driverMask, BITMODE_SYNC_BITBANG)
        try {
            // Synchronous bitbang produces one sample for every byte written, so the read has to
            // keep pace with the write. Writing the whole waveform first stalls once the chip's
            // modest FIFO fills, which shows up as a bulk-OUT failure part way through.
            val got = ByteArray(outLevels.size)
            var written = 0
            var read = 0
            val deadline = System.currentTimeMillis() + 6000
            val chunk = 48

            while (written < outLevels.size && System.currentTimeMillis() < deadline) {
                val n = minOf(chunk, outLevels.size - written)
                write(outLevels.copyOfRange(written, written + n), timeoutMs = 1000)
                written += n
                val back = readBytes(minOf(n, got.size - read), 400)
                back.copyInto(got, read)
                read += back.size
            }
            while (read < got.size && System.currentTimeMillis() < deadline) {
                val back = readBytes(got.size - read, 200)
                if (back.isEmpty()) break
                back.copyInto(got, read)
                read += back.size
            }
            return got.copyOf(read)
        } finally {
            runCatching { setBitMode(0x00, BITMODE_RESET) }
        }
    }

    /**
     * Result of [syncBitbangStream]. [elapsedMs] against [expectedMs] is what tells whether the
     * sample clock ran continuously, which decides whether the timings mean anything at all.
     */
    class BitbangCapture(
        val samples: ByteArray,
        val elapsedMs: Long,
        val expectedMs: Double,
    ) {
        /**
         * Synchronous bitbang only advances when there is a byte to write, so a starved TX FIFO
         * does not merely slow the transfer down - it stops the clock, and the samples either side
         * of the gap are no longer a fixed time apart. Wall-clock time is the only way to detect
         * that from the host, because the gap leaves no trace in the data.
         */
        val stalled: Boolean get() = elapsedMs > expectedMs * 1.3 + 20
    }

    /**
     * Streams a synchronous-bitbang waveform out and the samples back at the same time, so the
     * sample clock runs without gaps.
     *
     * [syncBitbangCapture] alternates a 48-byte write with a read on one thread. That caps the
     * throughput at a few tens of kB/s, which is below the sample rates worth using here, so the
     * chip's TX FIFO empties and the clock stalls - and a stalled clock silently destroys the edge
     * timing this is built to measure. One large transfer per direction on two threads lets the
     * host controller keep both FIFOs fed, which is no more than an ordinary serial port does at
     * the same rate in both directions.
     *
     * Bit 0 is TXD and bit 4 is the DTR pin; with both in [driverMask] the whole stimulus lives in
     * the waveform, on the same clock as the samples. That matters more than it sounds: a DTR pulse
     * issued as a control transfer sits an unknown several milliseconds away from the first sample,
     * which is most of a 14 ms burst.
     *
     * @param sampleRate wanted samples per second. The bitbang clock is *not* the baud rate the
     *   divisor encodes - it runs [clockMultiplier] times faster, which is why libftdi scales the
     *   requested rate before computing the divisor - so the divisor is set for
     *   `sampleRate / clockMultiplier` and [BitbangCapture.expectedMs] is reckoned from
     *   [sampleRate]. Measure the multiplier rather than trusting the default: a wrong factor
     *   scales every bit time and every duration derived from the capture by exactly that much.
     */
    fun syncBitbangStream(
        outLevels: ByteArray,
        sampleRate: Int,
        driverMask: Int,
        clockMultiplier: Int = 4,
    ): BitbangCapture {
        require(clockMultiplier >= 1) { "clock multiplier must be at least 1" }
        setBaudRate((sampleRate / clockMultiplier).coerceAtLeast(184))
        purge()
        setBitMode(driverMask, BITMODE_SYNC_BITBANG)
        try {
            val samples = ByteArray(outLevels.size)
            val expectedMs = outLevels.size * 1000.0 / sampleRate
            val deadline = System.currentTimeMillis() + (expectedMs * 4).toLong() + 2000
            var read = 0

            val reader = Thread { read = drainSamples(samples, deadline) }
            val t0 = System.currentTimeMillis()
            reader.start()

            var off = 0
            while (off < outLevels.size) {
                val slice = if (off == 0) outLevels else outLevels.copyOfRange(off, outLevels.size)
                val n = connection.bulkTransfer(epOut, slice, slice.size, 4000)
                if (n < 0) throw IOException("bitbang bulk OUT failed at offset $off of ${outLevels.size}")
                off += n
            }

            reader.join((deadline - System.currentTimeMillis()).coerceAtLeast(1))
            val elapsed = System.currentTimeMillis() - t0
            return BitbangCapture(samples.copyOf(read), elapsed, expectedMs)
        } finally {
            runCatching { setBitMode(0x00, BITMODE_RESET) }
        }
    }

    /**
     * Reads bulk IN into [target] until it is full or [deadlineMs] passes, stripping the two status
     * bytes FTDI puts at the head of every packet. Deliberately self-contained: it runs on its own
     * thread alongside a bulk OUT, so it must not touch [rawBuf] or [pending].
     */
    private fun drainSamples(target: ByteArray, deadlineMs: Long): Int {
        val buf = ByteArray(maxPacketSize * 64)
        var got = 0
        while (got < target.size && System.currentTimeMillis() < deadlineMs) {
            val n = connection.bulkTransfer(epIn, buf, buf.size, 50)
            if (n <= 2) continue
            var off = 0
            while (off + 2 <= n && got < target.size) {
                val packet = minOf(maxPacketSize, n - off)
                for (i in (off + 2) until (off + packet)) {
                    if (got >= target.size) break
                    target[got++] = buf[i]
                }
                off += packet
            }
        }
        return got
    }

    // ---------------------------------------------------------------- line probing

    /**
     * Reads the current logic level of the chip's pins without disturbing the UART.
     *
     * Bit 1 is RXD. On a healthy K-line this sits steadily high when the bus is idle, because the
     * bus is pulled up and every node is open-drain. A level that flickers instead is the signature
     * of an input that is not connected to anything - which is a completely different fault from a
     * bus that is connected but being decoded wrongly, and the two are otherwise hard to tell apart
     * from byte values alone.
     */
    fun readPins(): Int? {
        val buf = ByteArray(1)
        val n = connection.controlTransfer(REQ_TYPE_IN, SIO_READ_PINS, 0, portIndex, buf, 1, 500)
        if (n != 1) return null
        return buf[0].toInt() and 0xFF
    }

    /**
     * Samples [samples] pin readings and returns how often each distinct value was seen,
     * most frequent first.
     */
    fun samplePins(samples: Int = 200): List<Pair<Int, Int>> {
        val counts = HashMap<Int, Int>()
        repeat(samples) {
            val v = readPins() ?: return@repeat
            counts[v] = (counts[v] ?: 0) + 1
        }
        return counts.entries.sortedByDescending { it.value }.map { it.key to it.value }
    }

    /** Raw USB device descriptor, from which the FTDI chip generation can be read. */
    fun rawDescriptors(): ByteArray? = connection.rawDescriptors

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
        private const val SIO_MODEM_CTRL = 0x01
        private const val SIO_SET_FLOW_CTRL = 0x02
        private const val SIO_SET_BAUD_RATE = 0x03
        private const val SIO_SET_DATA = 0x04
        private const val SIO_SET_LATENCY_TIMER = 0x09
        private const val SIO_SET_BITMODE = 0x0B
        private const val SIO_READ_PINS = 0x0C

        const val BITMODE_RESET = 0x00
        const val BITMODE_ASYNC_BITBANG = 0x01
        const val BITMODE_SYNC_BITBANG = 0x04
        const val BITMODE_CBUS = 0x20

        /** FT232R CBUS pin function codes, as stored in EEPROM bytes 0x14-0x16. */
        fun cbusFunction(code: Int): String = when (code) {
            0x00 -> "TXDEN"
            0x01 -> "PWREN#"
            0x02 -> "RXLED#"
            0x03 -> "TXLED#"
            0x04 -> "TX&RXLED#"
            0x05 -> "SLEEP#"
            0x06 -> "CLK48"
            0x07 -> "CLK24"
            0x08 -> "CLK12"
            0x09 -> "CLK6"
            0x0A -> "IOMODE (software-driven GPIO)"
            0x0B -> "BitBangWR#"
            0x0C -> "BitBangRD#"
            else -> "unknown(0x%X)".format(code)
        }
        private const val SIO_READ_EEPROM = 0x90

        /** bcdDevice values identifying the FTDI generation. */
        fun chipName(bcdDevice: Int): String = when (bcdDevice) {
            0x0200 -> "FT8U232AM / FT8U245AM"
            0x0400 -> "FT232BM / FT245BM"
            0x0500 -> "FT2232C/D"
            0x0600 -> "FT232R / FT245R"
            0x0700 -> "FT2232H"
            0x0800 -> "FT4232H"
            0x0900 -> "FT232H"
            0x1000 -> "FT-X series"
            else -> "unrecognised"
        }

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
