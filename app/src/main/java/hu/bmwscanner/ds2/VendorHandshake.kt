package hu.bmwscanner.ds2

/**
 * The cable's announcement, decoded the way the vendor's own software decodes it.
 *
 * This is not inferred from the wire. It is transcribed from `FUN_006ce388` in the unpacked
 * `BMWScan140.exe` (see `docs/findings.md`, run 21), which after its DTR pulse reads exactly
 * `0x1B` bytes, requires their XOR to be zero, takes the first byte as a descrambling key, XORs
 * the remainder with it, and assembles bytes 1 to 7 into a hardware identity string.
 *
 * It lives here rather than in the Activity so the decode can be pinned by a unit test against the
 * bytes actually captured from the car. That matters more than usual: this project spent nineteen
 * runs reading those bytes as noise, and run 9 concluded in print that they were an analogue
 * transient. They were not. A transient does not carry a valid checksum over a payload that spells
 * the hardware string printed in the vendor's own shipped log.
 */
object VendorHandshake {

    /** The announcement is a fixed 27 bytes; the vendor's loop counts to `0x1B` and no further. */
    const val LENGTH = 27

    /** Characters 1 through 7 of the descrambled announcement. */
    const val IDENTITY_LENGTH = 7

    /** What this cable is expected to call itself, from the vendor's 2009 session log header. */
    const val EXPECTED_IDENTITY = "V144Bn9"

    data class Result(
        /** The raw bytes exactly as they arrived. */
        val raw: ByteArray,
        /** Byte 0, which is both the first byte and the key for everything after it. */
        val key: Int,
        /** The announcement with bytes 1 onwards descrambled. */
        val decoded: ByteArray,
        /** Bytes 1–7 as text; `V144Bn9` on this cable. */
        val identity: String,
        /** Everything after the identity and its terminator: serial or licence data, unparsed. */
        val remainder: ByteArray,
    )

    /**
     * Returns the decoded announcement, or null if [raw] is not one.
     *
     * Both rejections are the vendor's own: a length other than 27, or a non-zero XOR across all
     * 27 bytes. Nothing here is lenient, because a near-miss is exactly how this project talked
     * itself into the wrong answer before.
     */
    fun decode(raw: ByteArray): Result? {
        if (raw.size != LENGTH) return null
        if (!checksumOk(raw)) return null

        val key = raw[0].toInt() and 0xFF
        val decoded = ByteArray(LENGTH)
        decoded[0] = raw[0]
        for (i in 1 until LENGTH) decoded[i] = ((raw[i].toInt() and 0xFF) xor key).toByte()

        val identity = buildString {
            for (i in 1..IDENTITY_LENGTH) {
                val c = decoded[i].toInt() and 0xFF
                append(if (c in 32..126) c.toChar() else '.')
            }
        }

        return Result(
            raw = raw,
            key = key,
            decoded = decoded,
            identity = identity,
            remainder = decoded.copyOfRange(IDENTITY_LENGTH + 2, LENGTH),
        )
    }

    /** The whole announcement XORs to zero; that is the only integrity check the vendor applies. */
    fun checksumOk(raw: ByteArray): Boolean {
        var x = 0
        for (b in raw) x = x xor (b.toInt() and 0xFF)
        return x == 0
    }
}
