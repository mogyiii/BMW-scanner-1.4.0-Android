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
         * `FUN_006ccdd4` singles this one out: when the frame's command bytes are `0x83 0xF0` it
         * takes a different path with a much longer wait, which is what a request forwarded to a
         * control module and back would need.
         */
        const val BUS = 0x83F0
    }

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
