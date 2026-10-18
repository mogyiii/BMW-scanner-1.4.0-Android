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

    /** First index at which [needle] occurs in [haystack] at or after [from], or -1. */
    fun indexOf(haystack: ByteArray, needle: ByteArray, from: Int = 0): Int {
        if (needle.isEmpty() || needle.size > haystack.size) return -1
        outer@ for (i in from..(haystack.size - needle.size)) {
            for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
            return i
        }
        return -1
    }

    /** A checksum-valid DS2 frame located somewhere inside a larger capture. */
    data class Located(val offset: Int, val frame: ByteArray)

    /**
     * Scans [data] from [from] for a checksum-valid DS2 frame starting at *any* offset.
     *
     * The earlier implementation assumed a reply began at byte zero of whatever came back. That is
     * naive on a K-line: the transceiver commonly emits a spurious byte - a framing error from the
     * line settling - at the start of a transmission, and a single leading junk byte is enough to
     * push every subsequent field one place along and make a perfectly good frame unparseable. So
     * resynchronise instead of assuming alignment.
     *
     * When [preferAddress] is given, a frame from that address wins over an equally valid one from
     * somewhere else, since that is the module we actually asked.
     */
    fun findFrame(data: ByteArray, from: Int = 0, preferAddress: Int? = null): Located? {
        var fallback: Located? = null
        var i = from.coerceAtLeast(0)
        while (i <= data.size - 3) {
            val len = data[i + 1].toInt() and 0xFF
            if (len in 3..(data.size - i)) {
                val frame = data.copyOfRange(i, i + len)
                val want = frame[frame.size - 1].toInt() and 0xFF
                if (checksum(frame, 0, frame.size - 1) == want) {
                    val located = Located(i, frame)
                    val addr = frame[0].toInt() and 0xFF
                    if (preferAddress == null || addr == preferAddress) return located
                    if (fallback == null) fallback = located
                }
            }
            i++
        }
        return fallback
    }

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
    /** Offset in [raw] where our own transmission came back, or -1 if it never did. */
    val echoOffset: Int = -1,
    /** Offset in [raw] where the reply frame was found, or -1. */
    val frameOffset: Int = -1,
) {
    val address: Int? get() = response?.takeIf { it.size >= 2 }?.get(0)?.toInt()?.and(0xFF)

    /** Payload between the length byte and the checksum. */
    val payload: ByteArray?
        get() = response?.takeIf { it.size >= 3 }?.copyOfRange(2, response.size - 1)

    fun describe(): String = buildString {
        append("TX  ").append(Ds2.hex(request)).append('\n')
        append("RX  ").append(if (raw.isEmpty()) "(nothing)" else Ds2.hex(raw)).append('\n')
        if (response != null) {
            append("    frame @${frameOffset}: ").append(Ds2.hex(response)).append('\n')
            payload?.let { append("    payload: ").append(Ds2.hex(it)).append('\n') }
        }
        append("    echo: ")
        append(
            when {
                echoOffset == 0 -> "at offset 0, as expected"
                echoOffset > 0 -> "at offset $echoOffset - $echoOffset stray byte(s) came first"
                else -> "never came back"
            },
        )
        append('\n')
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
 * The K-line is a single bidirectional wire, so interface hardware generally feeds transmitted
 * bytes straight back into the receiver. This used to be a toggle the caller had to guess at; it is
 * now detected per transaction by looking for the request inside the captured reply, which is both
 * more reliable and one less thing to sweep over.
 */
class Ds2Link(private val ftdi: FtdiDevice) {

    /** Sends [payload] to [address] and tries to read one framed response. */
    fun transact(address: Int, payload: ByteArray, timeoutMs: Int = 1000): Ds2Result {
        val request = Ds2.frame(address, payload)
        return sendRaw(request, timeoutMs)
    }

    /**
     * Sends an already-framed (or deliberately malformed) request and analyses everything that
     * comes back.
     *
     * Strategy: capture the whole reply window first, then interpret it - rather than reading two
     * header bytes and trusting them to be the start of a frame. A K-line transceiver readily
     * contributes a spurious byte of its own, and one stray leading byte is enough to make a
     * perfectly good reply unreadable if you assume alignment. Capturing first also means the raw
     * bytes are preserved for the log even when nothing parses, which is the whole point while the
     * protocol is still being mapped.
     */
    fun sendRaw(request: ByteArray, timeoutMs: Int = 1000): Ds2Result {
        ftdi.purge()
        ftdi.write(request)

        val raw = ftdi.readUntilQuiet(
            quietMs = 40,
            overallTimeoutMs = timeoutMs.coerceAtLeast(120),
        )

        val expectedAddress = if (request.isNotEmpty()) request[0].toInt() and 0xFF else null

        // Where, if anywhere, did our own transmission come back?
        val echoAt = Ds2.indexOf(raw, request)
        val echoOk = echoAt >= 0

        // Look for a reply after the echo first; a module cannot answer before we finish asking.
        var located = if (echoAt >= 0) {
            Ds2.findFrame(raw, echoAt + request.size, expectedAddress)
        } else {
            null
        }
        var searchedWholeBuffer = false
        if (located == null) {
            located = Ds2.findFrame(raw, 0, expectedAddress)
            searchedWholeBuffer = true
            // A "frame" that is just our own request echoed is not a reply.
            if (located != null && located.frame.contentEquals(request)) {
                located = Ds2.findFrame(raw, located.offset + located.frame.size, expectedAddress)
            }
        }

        val note = buildString {
            when {
                raw.isEmpty() -> append("silence")
                located == null && echoAt == 0 && raw.size == request.size ->
                    append("exact echo only, no reply")
                located == null && echoOk ->
                    append("echo found at offset $echoAt, no valid frame after it")
                located == null ->
                    append("no echo and no valid frame in ${raw.size} byte(s)")
                else -> {
                    append("frame at offset ${located.offset}")
                    if (echoAt > 0) append("; echo was offset by $echoAt byte(s)")
                    if (searchedWholeBuffer && echoAt < 0) append("; no echo seen")
                }
            }
        }

        return Ds2Result(
            request = request,
            raw = raw,
            response = located?.frame,
            echoOk = echoOk,
            checksumOk = located != null,
            note = note,
            lineStatus = ftdi.lastLineStatus,
            echoOffset = echoAt,
            frameOffset = located?.offset ?: -1,
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
