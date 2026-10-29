package hu.bmwscanner.ds2

/**
 * The cable's own command protocol, transcribed from the vendor executable and checked against
 * bytes captured from it.
 *
 * Two pieces, both recovered from the unpacked `BMWScan140.exe` (`docs/findings.md`, runs 21–22):
 *
 *  - **Framing**, from `FUN_006cd09c`, which assembles a frame at `0x008dda60` as a length byte, a
 *    sixteen-bit command, a parameter, an optional payload and an additive checksum.
 *  - **Scrambling**, from `FUN_006ccdd4`, which XORs every outgoing byte with a key that advances
 *    by `0x4B` per byte and is *not* reset between frames. The key starts as the first byte of the
 *    cable's announcement, which `VendorHandshake` recovers.
 *
 * Both are confirmed by the capture rather than taken on trust. Unscrambling the recorded traffic
 * with the right key yields frames whose length byte and checksum are both correct, and the key one
 * frame ends on is exactly the key the next frame begins with — `0x42 + 5 × 0x4B = 0xB9`, measured.
 *
 * **That chaining does not hold across all traffic, and the earlier version of this comment was
 * wrong to imply it did.** The two 19200 ident frames chain as described, but the two 9600 `0x83F0`
 * frames recorded in the same session are *both* scrambled with key `0x7B` — the second did not
 * continue from where the first ended, and neither continued from the ident frames between them.
 * See [BUS_KEY_OFFSET] for what is and is not established about that.
 *
 * Nothing here invents a command. The commands this project knows are the ones the vendor was
 * observed sending, and they are listed as such.
 */
object VendorProtocol {

    /** How far the scrambling key advances for each byte put on the wire. */
    const val KEY_STEP = 0x4B

    /**
     * Commands seen in the capture, with the line settings they were sent at. Their meaning is not
     * established beyond what the capture shows, and none of them is a guess.
     */
    object Command {
        /** Sent twice at 19200 8N1 during *Car ident*, parameter `0x12`, no payload. */
        const val IDENT = 0x41AA

        /**
         * Sent at 9600 8E1 — the DS2 line setting — with a six-byte payload.
         *
         * **Not a request for vehicle data.** `FUN_006b92c0` builds all six of its occurrences
         * identically: `E5 50 47 66` then `Delay2` and `Delay` from `bmwscan.ini`. It configures
         * K-line timing for one module, selected by the parameter byte, which the module table
         * holds at `+0x2F4` of each record. See `docs/findings.md`, run 29.
         */
        const val BUS = 0x83F0

        /**
         * The frame the vendor software sends **immediately after the announcement**, carrying the
         * cable's own identity back to it along with twenty-five further bytes.
         *
         * Recovered on 2026-10-28 by feeding the shim our cable's real 27-byte announcement and
         * letting `BMWScan140.exe` answer it. Until then the shim had replied with a guessed
         * string, the software never believed a cable was present, and this frame was never built.
         *
         * Its shape says what it is. The parameter byte is `0x56`, `'V'`, and the payload opens
         * `31 34 34 42 6E 39`, `"144Bn9"` — together the identity `V144Bn9` the cable just
         * announced. A device announcing itself and a host repeating that identity back with a
         * further twenty-five bytes is a challenge and a response.
         */
        const val SIGN_ON = 0xA77A

        /**
         * Part of **opening the connection**, sent once per connection with a payload of `0x01`.
         *
         * An earlier version of this comment called it "the command that asks a module to identify
         * itself" and "the command the project spent weeks without". **Both were wrong**, and the
         * mistake is worth recording because the evidence looked conclusive: run 35 saw it
         * eighty-four times, once per module address, which reads exactly like a per-module query.
         *
         * It is not. The binary has a single call site, inside `FUN_006ceba8`, which is reached
         * only from `FUN_006c9dc4` — the function that establishes the link, guarded by
         * `DAT_00a4cf18` so it runs once while disconnected. It appeared once per module in the
         * capture because every attempt failed against the shim's substituted reply, so the
         * software tore the link down and rebuilt it from nothing for the next address.
         *
         * Which means **everything run 35 captured is connection setup**, and the command that
         * actually asks a module for data was never sent. It is still missing.
         *
         * Sending this is still worth doing: a real reply to it is what the shim needs before the
         * software will believe a connection succeeded and go on to the queries that matter.
         */
        const val MODULE = 0xB318
    }

    /**
     * The sixty-three module addresses the vendor software works through, in order.
     *
     * Taken from the parameter bytes of the [Command.MODULE] frames in that same run, so this is
     * the program's own list rather than a published table. Note what that means given what
     * [Command.MODULE] turned out to be: these are the addresses the software *set up a connection
     * for*, one failed attempt each, not addresses it successfully queried. Several entries line up with the
     * familiar DS2 addresses — `0x12` the engine controller, `0x80` the instrument cluster, `0x44`
     * the immobiliser, `0xA4` the airbag controller — but that correspondence is recognition, not
     * something this capture proves.
     */
    val MODULE_ADDRESSES: IntArray = intArrayOf(
        0x00, 0x08, 0x12, 0x13, 0x16, 0x18, 0x1B, 0x1E, 0x22, 0x24, 0x28, 0x29,
        0x2E, 0x30, 0x32, 0x34, 0x3B, 0x40, 0x44, 0x47, 0x48, 0x4A, 0x50, 0x51,
        0x56, 0x57, 0x5A, 0x5B, 0x60, 0x65, 0x66, 0x68, 0x6A, 0x6B, 0x70, 0x72,
        0x74, 0x7F, 0x80, 0x81, 0x86, 0x98, 0x9A, 0x9B, 0x9C, 0x9E, 0xA0, 0xA4,
        0xA6, 0xA7, 0xAC, 0xB0, 0xBB, 0xC0, 0xC2, 0xC8, 0xCE, 0xD0, 0xDA, 0xE8,
        0xED, 0xF0, 0xF5,
    )

    /** The one [Command.MODULE] payload ever observed; the single call site hard-codes it. */
    const val QUERY_IDENTIFY = 0x01

    /**
     * The exact sign-on frame the vendor software produced for **this** cable.
     *
     * It is replayable only because the shim fed the software our cable's genuine announcement, so
     * the twenty-five trailing bytes were computed from the real challenge rather than a fiction.
     * That also fixes its scope: **this frame is valid for one cable and one announcement.** If the
     * announcement ever differs — a different cable, or the same cable announcing something new —
     * these bytes are meaningless and must not be sent. [matchesRecordedCable] exists so a caller
     * checks rather than assumes.
     *
     * How the trailing bytes are derived is not known. Deriving them would make this work for any
     * cable; replaying them works for ours, which is what the project needs first.
     */
    val SIGN_ON_FRAME: ByteArray = byteArrayOf(
        0x22, 0xA7.toByte(), 0x7A, 0x56, 0x31, 0x34, 0x34, 0x42, 0x6E, 0x39,
        0x9D.toByte(), 0x3E, 0xAF.toByte(), 0x2E, 0xA9.toByte(), 0x45, 0x78, 0x80.toByte(),
        0xB7.toByte(), 0xAA.toByte(), 0xF6.toByte(), 0xA9.toByte(), 0xFC.toByte(), 0x9F.toByte(),
        0xEE.toByte(), 0xD2.toByte(), 0x7C, 0x59, 0x90.toByte(), 0x79, 0x80.toByte(), 0x59,
        0x84.toByte(), 0x88.toByte(), 0x03, 0xDA.toByte(),
    )

    /** The 27 announcement bytes [SIGN_ON_FRAME] was computed against, exactly as recorded. */
    val RECORDED_ANNOUNCEMENT: ByteArray = byteArrayOf(
        0x9B.toByte(), 0xCD.toByte(), 0xAA.toByte(), 0xAF.toByte(), 0xAF.toByte(), 0xD9.toByte(),
        0xF5.toByte(), 0xA2.toByte(), 0x9B.toByte(), 0x17, 0x28, 0xFE.toByte(), 0x72, 0xD1.toByte(),
        0x17, 0x4C, 0x5E, 0x80.toByte(), 0x38, 0x09, 0xED.toByte(), 0x2E, 0xB5.toByte(),
        0xCF.toByte(), 0xAA.toByte(), 0x07, 0x2B,
    )

    /**
     * Whether [announcement] is the one [SIGN_ON_FRAME] answers.
     *
     * Sending a response computed for a different challenge is not a harmless experiment - it is
     * sending bytes nobody has ever observed, which is the one thing this project does not do.
     */
    fun matchesRecordedCable(announcement: ByteArray): Boolean =
        announcement.contentEquals(RECORDED_ANNOUNCEMENT)

    /**
     * Builds one unscrambled frame.
     *
     * Layout, straight from the decompiled builder:
     *
     * ```
     * [0]      frame length minus two
     * [1]      command, high byte
     * [2]      command, low byte
     * [3]      parameter
     * [4..]    payload, when there is one
     * [last]   sum of every preceding byte, modulo 256
     * ```
     *
     * A frame with no payload is five bytes; the builder reaches that by being handed a payload
     * length of -1, which is worth knowing when comparing this against the disassembly.
     */
    fun buildFrame(command: Int, parameter: Int, payload: ByteArray = ByteArray(0)): ByteArray {
        val frame = ByteArray(payload.size + 5)
        frame[0] = (frame.size - 2).toByte()
        frame[1] = ((command shr 8) and 0xFF).toByte()
        frame[2] = (command and 0xFF).toByte()
        frame[3] = (parameter and 0xFF).toByte()
        payload.copyInto(frame, 4)
        var sum = 0
        for (i in 0 until frame.size - 1) sum = (sum + (frame[i].toInt() and 0xFF)) and 0xFF
        frame[frame.size - 1] = sum.toByte()
        return frame
    }

    /** True when [frame]'s length byte and trailing checksum both agree with its contents. */
    fun frameOk(frame: ByteArray): Boolean {
        if (frame.size < 5) return false
        if ((frame[0].toInt() and 0xFF) != frame.size - 2) return false
        var sum = 0
        for (i in 0 until frame.size - 1) sum = (sum + (frame[i].toInt() and 0xFF)) and 0xFF
        return sum == (frame[frame.size - 1].toInt() and 0xFF)
    }

    /**
     * XORs [data] with the rolling key, returning the result and the key the next byte would use.
     *
     * The same transform undoes itself, so this descrambles a capture as readily as it scrambles a
     * frame for sending — which is how the format was confirmed in the first place.
     */
    fun scramble(data: ByteArray, startKey: Int): Pair<ByteArray, Int> {
        var key = startKey and 0xFF
        val out = ByteArray(data.size)
        for (i in data.indices) {
            out[i] = ((data[i].toInt() and 0xFF) xor key).toByte()
            key = (key + KEY_STEP) and 0xFF
        }
        return out to key
    }

    /** Where the key stands after [byteCount] bytes have gone out from [startKey]. */
    fun advanceKey(startKey: Int, byteCount: Int): Int =
        (startKey + KEY_STEP * byteCount) and 0xFF

    /**
     * How far past the announcement byte the recorded [Command.BUS] frames were scrambled from.
     *
     * Both `0x83F0` frames in the capture use key `0x7B`, and the session's announcement began with
     * `0x42`, so each sat exactly eleven key steps past the start — eleven being also the length of
     * the frame itself. That arithmetic is solid; **what produces it is not.** Three readings fit
     * two samples equally well:
     *
     *  - the bus path keeps its own key register, reset per transaction to eleven steps in;
     *  - the key is pre-advanced by the frame's own length before use on this path;
     *  - `0x7B` is simply a constant for this command and the announcement is irrelevant.
     *
     * The first two make the key depend on the cable's announcement, the third does not, and they
     * disagree on every cable whose announcement does not start with `0x42` — including ours, which
     * starts with `0x9B`.
     *
     * **Run 27 settled it on the hardware, against the third reading.** Sent as the first frame of
     * a session, the bus frame scrambled from our own announcement key `0x9B` drew a clean answer,
     * while the same frame scrambled from the literal `0x7B` drew nothing parseable. The key comes
     * from the announcement. These two constants are kept because they record what the capture
     * showed, but [BUS_KEY_OBSERVED] is that session's key and not this cable's — do not send with
     * it.
     */
    const val BUS_KEY_OFFSET = 11

    /** The literal key both recorded [Command.BUS] frames were scrambled with. */
    const val BUS_KEY_OBSERVED = 0x7B

    /**
     * How the cable answers, as observed on the car and as the receive half of `FUN_006ccdd4`
     * expects it.
     *
     * Two things the first live exchange settled, neither of which was obvious from the code alone:
     *
     *  - **Replies are not scrambled.** The first three bytes come back as the command and parameter
     *    that were sent, in plain, while the outgoing frame carrying them was XORed. Only the host
     *    to cable direction is obfuscated.
     *  - **The echo is separate from the frame.** After those three bytes the reply proper begins,
     *    and its length follows the mode rules — or one of two fixed sentinels.
     *
     * Observed: sending `03 41 AA 12 00` returned `41 AA 12 | 77 07 77 07 77 07 70`, which is a
     * three-byte echo followed by exactly seven bytes, the length `FUN_006ccdd4` assigns when a
     * reply opens with `77 07`.
     *
     * **The split is an assumption and the executable does not support it.** `FUN_006ca098` writes
     * a byte and reads nothing back, so the vendor's receive buffer begins at the first byte that
     * arrives, not three bytes in; under its mode-2 rule that buffer's second byte is a length, and
     * `0xAA` is not one. Either the cable answers us differently than it answers the vendor, or
     * those three bytes are something other than an echo, or the mode in play is not 2. Treat
     * [Reply.body] and [Reply.sentinel] as provisional until a reply turns up whose length can be
     * checked against the code - see `docs/findings.md`, run 29.
     */
    object Sentinel {
        /** Reply opens `77 07`: fixed length seven, and the routine simply returns. */
        const val SEVEN_A = 0x7707

        /** Reply opens `7A 07`: fixed length seven, and the routine also raises its abort flag. */
        const val SEVEN_B = 0x7A07
    }

    data class Reply(
        /** Command echoed back by the cable, plain. */
        val command: Int,
        /** Parameter echoed back by the cable, plain. */
        val parameter: Int,
        /** Everything after the echo. */
        val body: ByteArray,
        /** Set when [body] opens with one of the two fixed-length sentinels. */
        val sentinel: Int?,
        /** True when the echo matches what was sent, so the reply belongs to this request. */
        val echoMatches: Boolean,
    )

    /**
     * Splits a raw reply into its echo and body, and reports whether the echo is the expected one.
     *
     * Deliberately does no length arithmetic of its own: the mode rules live in the caller, and a
     * reply that arrived short should be visible as short rather than quietly reinterpreted.
     */
    fun parseReply(raw: ByteArray, sentCommand: Int, sentParameter: Int): Reply? {
        if (raw.size < 3) return null
        val command = ((raw[0].toInt() and 0xFF) shl 8) or (raw[1].toInt() and 0xFF)
        val parameter = raw[2].toInt() and 0xFF
        val body = raw.copyOfRange(3, raw.size)
        val head = if (body.size >= 2)
            ((body[0].toInt() and 0xFF) shl 8) or (body[1].toInt() and 0xFF) else -1
        return Reply(
            command = command,
            parameter = parameter,
            body = body,
            sentinel = if (head == Sentinel.SEVEN_A || head == Sentinel.SEVEN_B) head else null,
            echoMatches = command == sentCommand && parameter == sentParameter,
        )
    }

    /**
     * Tries every starting key and returns those that make [scrambled] a well-formed frame.
     *
     * Useful for reading a capture whose key history is unknown, and the tool that established the
     * framing: a wrong key essentially never produces both a correct length byte and a correct
     * checksum, so a single surviving candidate is as good as knowing the key.
     */
    fun recoverFrame(scrambled: ByteArray): List<Pair<Int, ByteArray>> =
        (0..0xFF).mapNotNull { k ->
            val (plain, _) = scramble(scrambled, k)
            if (frameOk(plain)) k to plain else null
        }
}
