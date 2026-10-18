package hu.bmwscanner.ds2

import hu.bmwscanner.usb.FtdiDevice

/**
 * BMW DS2 framing over the K-line.
 *
 * CONFIDENCE NOTE - read before trusting anything here.
 *
 * The frame layout and checksum below are well attested across independent public descriptions of
 * the DS2 bus and are treated as known:
 *
 *     request   [ADDR] [LEN] [DATA ...] [CS]
 *     response  [ADDR] [LEN] [DATA ...] [CS]
 *
 *     LEN = total frame length in bytes, counting ADDR, LEN, DATA and CS
 *     CS  = XOR of every byte that precedes it
 *
 * The *command bytes* and *ECU addresses* are a different matter. We did not recover them from the
 * original BMWScan140.exe - that binary is packed and cannot be decompiled statically (see
 * docs/findings.md) - so everything in [Command] and [KnownEcu] is a labelled candidate to be
 * confirmed or discarded against the real car. [Ds2Link.scanBus] exists precisely so the app can
 * discover the live addresses itself instead of relying on a table.
 */
object Ds2 {

    const val BAUD = 9600

    /** Status byte many modules place first in the response payload. Candidate values. */
    object Status {
        const val OK = 0xA0
        const val BUSY = 0xA1
        const val BAD_PARAM = 0xA2
        const val BAD_COMMAND = 0xA3
    }

    /**
     * Candidate command bytes. Only [IDENTIFY] is used by the initial probe build; the rest are
     * here as a checklist of things to try from the hex terminal and promote once a real module
     * answers. Do not present unverified entries to the user as facts.
     */
    object Command {
        /** Device identification. The most widely documented DS2 request. */
        const val IDENTIFY = 0x00

        /** Candidate: read fault memory. UNVERIFIED. */
        const val READ_FAULTS = 0x04

        /** Candidate: clear fault memory. UNVERIFIED. */
        const val CLEAR_FAULTS = 0x05

        /** Candidate: read measurement block / analogue values. UNVERIFIED. */
        const val READ_BLOCK = 0x0B
    }

    /**
     * Candidate ECU addresses. UNVERIFIED - present only to order the bus scan so the modules most
     * likely to exist get probed first. The scan itself covers the whole 0x00..0xFF space.
     */
    val KnownEcu: Map<Int, String> = linkedMapOf(
        0x00 to "DME (engine) - candidate",
        0x12 to "EGS (automatic gearbox) - candidate",
        0x16 to "ABS / ASC / DSC - candidate",
        0x44 to "EWS (immobiliser) - candidate",
        0x56 to "LCM (light module) - candidate",
        0x60 to "IKE (instrument cluster) - candidate",
        0x80 to "IHKA (climate) - candidate",
        0xA0 to "AirBag / SRS - candidate",
    )

    /** A module counts as present when a checksum-valid frame came back from the address we asked. */
    fun isPresent(address: Int, result: Ds2Result): Boolean =
        result.response != null && result.checksumOk && result.address == address

    /** XOR of all bytes in [data], which is how DS2 checksums both directions. */
    fun checksum(data: ByteArray, from: Int = 0, until: Int = data.size): Int {
        var cs = 0
        for (i in from until until) cs = cs xor (data[i].toInt() and 0xFF)
        return cs and 0xFF
    }

    /** Builds a complete request frame, filling in the length and checksum. */
    fun frame(address: Int, payload: ByteArray): ByteArray {
        val len = payload.size + 3 // ADDR + LEN + payload + CS
        require(len <= 0xFF) { "payload too long for a DS2 frame: ${payload.size} bytes" }
        val out = ByteArray(len)
        out[0] = address.toByte()
        out[1] = len.toByte()
        payload.copyInto(out, 2)
        out[len - 1] = checksum(out, 0, len - 1).toByte()
        return out
    }

    fun frame(address: Int, vararg payload: Int): ByteArray =
        frame(address, ByteArray(payload.size) { payload[it].toByte() })

    fun hex(data: ByteArray): String =
        data.joinToString(" ") { "%02X".format(it.toInt() and 0xFF) }

    /** Parses "12 04 00" / "120400" / "0x12,0x04" into bytes. Throws on a stray token. */
    fun parseHex(text: String): ByteArray {
        val cleaned = text.replace("0x", " ", ignoreCase = true)
            .replace(",", " ")
            .replace(";", " ")
            .trim()
        if (cleaned.isEmpty()) return ByteArray(0)

        val tokens = if (cleaned.contains(' ')) {
            cleaned.split(Regex("\\s+"))
        } else {
            require(cleaned.length % 2 == 0) { "odd number of hex digits in \"$text\"" }
            cleaned.chunked(2)
        }
        return ByteArray(tokens.size) { i ->
            val t = tokens[i]
            val v = t.toIntOrNull(16) ?: throw IllegalArgumentException("\"$t\" is not hex")
            require(v in 0..0xFF) { "\"$t\" does not fit in a byte" }
            v.toByte()
        }
    }
}

/** Outcome of one request/response exchange. Always carries the raw bytes for debugging. */
data class Ds2Result(
    val request: ByteArray,
    /** Everything read back, echo included, exactly as it came off the wire. */
    val raw: ByteArray,
    /** Response frame with the request echo removed, if one could be isolated. */
    val response: ByteArray?,
    val echoOk: Boolean,
    val checksumOk: Boolean,
    val note: String,
    /** FTDI line-status byte seen during the read; non-zero means a parity/framing problem. */
    val lineStatus: Int,
) {
    val address: Int? get() = response?.takeIf { it.size >= 2 }?.get(0)?.toInt()?.and(0xFF)

    /** Payload between the length byte and the checksum. */
    val payload: ByteArray?
        get() = response?.takeIf { it.size >= 3 }?.copyOfRange(2, response.size - 1)

    fun describe(): String = buildString {
        append("TX  ").append(Ds2.hex(request)).append('\n')
        append("RX  ").append(if (raw.isEmpty()) "(nothing)" else Ds2.hex(raw)).append('\n')
        if (response != null) {
            append("    frame: ").append(Ds2.hex(response))
            append("  cs=").append(if (checksumOk) "ok" else "BAD")
            append('\n')
            payload?.let { append("    payload: ").append(Ds2.hex(it)).append('\n') }
        }
        if (!echoOk) append("    echo mismatch\n")
        if (lineStatus and 0x0E != 0) {
            append("    line status 0x%02X -".format(lineStatus))
            if (lineStatus and 0x02 != 0) append(" overrun")
            if (lineStatus and 0x04 != 0) append(" PARITY-ERROR")
            if (lineStatus and 0x08 != 0) append(" FRAMING-ERROR")
            append(" (wrong parity or baud?)\n")
        }
        if (note.isNotEmpty()) append("    ").append(note).append('\n')
    }
}

/**
 * DS2 transport on top of [FtdiDevice].
 *
 * @param echoExpected the K-line is a single bidirectional wire, so most interface hardware feeds
 *   the transmitted bytes straight back into the receiver. Whether this cable does is not yet
 *   known, so the behaviour is a toggle rather than an assumption: when enabled the link consumes
 *   and verifies its own request before looking for a reply.
 */
class Ds2Link(
    private val ftdi: FtdiDevice,
    var echoExpected: Boolean = true,
) {

    /** Sends [payload] to [address] and tries to read one framed response. */
    fun transact(address: Int, payload: ByteArray, timeoutMs: Int = 1000): Ds2Result {
        val request = Ds2.frame(address, payload)
        return sendRaw(request, timeoutMs)
    }

    /** Sends an already-framed (or deliberately malformed) request. Used by the hex terminal. */
    fun sendRaw(request: ByteArray, timeoutMs: Int = 1000): Ds2Result {
        ftdi.purge()
        ftdi.write(request)

        val collected = ArrayList<Byte>()
        var echoOk = true
        var note = ""

        if (echoExpected) {
            val echo = ftdi.readBytes(request.size, timeoutMs)
            collected.addAll(echo.toList())
            if (!echo.contentEquals(request)) {
                echoOk = false
                note = if (echo.isEmpty()) {
                    "no echo seen - try turning echo cancellation off"
                } else {
                    "echo differs from request (bus contention, or echo cancellation is wrong here)"
                }
            }
        }

        // Header first: address + length tell us exactly how much more to wait for.
        val header = ftdi.readBytes(2, timeoutMs)
        collected.addAll(header.toList())

        var response: ByteArray? = null
        var checksumOk = false

        if (header.size == 2) {
            val len = header[1].toInt() and 0xFF
            if (len in 3..0xFF) {
                val rest = ftdi.readBytes(len - 2, timeoutMs)
                collected.addAll(rest.toList())
                if (rest.size == len - 2) {
                    val frame = header + rest
                    response = frame
                    checksumOk = Ds2.checksum(frame, 0, frame.size - 1) ==
                        (frame[frame.size - 1].toInt() and 0xFF)
                    if (!checksumOk && note.isEmpty()) note = "checksum mismatch"
                } else if (note.isEmpty()) {
                    note = "truncated: length byte says $len, got ${2 + rest.size}"
                }
            } else if (note.isEmpty()) {
                note = "implausible length byte 0x%02X".format(len)
            }
        } else if (note.isEmpty()) {
            note = if (header.isEmpty()) "silence" else "only ${header.size} byte(s) back"
        }

        // Sweep up anything still arriving so it cannot pollute the next exchange.
        val trailing = ftdi.readUntilQuiet(quietMs = 30, overallTimeoutMs = 120)
        collected.addAll(trailing.toList())
        if (trailing.isNotEmpty() && response != null) {
            note = (if (note.isEmpty()) "" else "$note; ") + "${trailing.size} extra byte(s) after frame"
        }

        return Ds2Result(
            request = request,
            raw = collected.toByteArray(),
            response = response,
            echoOk = echoOk,
            checksumOk = checksumOk,
            note = note,
            lineStatus = ftdi.lastLineStatus,
        )
    }

    /** One identification request to [address]. */
    fun identify(address: Int, timeoutMs: Int = 600): Ds2Result =
        transact(address, byteArrayOf(Ds2.Command.IDENTIFY.toByte()), timeoutMs)

    /**
     * Walks an address range sending identification requests, reporting every address that answers
     * with something structurally valid. This is the app's substitute for an ECU address table: the
     * car tells us which modules exist rather than us guessing.
     */
    fun scanBus(
        from: Int = 0x00,
        to: Int = 0xFF,
        timeoutMs: Int = 300,
        shouldStop: () -> Boolean = { false },
        onProgress: (address: Int, result: Ds2Result) -> Unit,
    ): List<Pair<Int, Ds2Result>> {
        val hits = ArrayList<Pair<Int, Ds2Result>>()
        val order = Ds2.KnownEcu.keys.filter { it in from..to } +
            (from..to).filter { it !in Ds2.KnownEcu.keys }

        for (addr in order) {
            if (shouldStop()) break
            val r = identify(addr, timeoutMs)
            onProgress(addr, r)
            if (Ds2.isPresent(addr, r)) hits.add(addr to r)
        }
        return hits
    }
}
