package hu.bmwscanner.ds2

/**
 * The cable's two-stage read, transcribed from `FUN_006ccdd4` and `FUN_006ccf80`.
 *
 * Every run up to 27 read the cable once after writing a command and treated whatever came back as
 * the answer. The executable does it in two stages, and missing the second is why no run has ever
 * seen data from a control module:
 *
 *  1. **The cable's acknowledgement**, read by `FUN_006ccdd4` into `DAT_008ddb60`. This is where the
 *     `77 07` and `7A 07` blocks live — the receive half checks those two openings explicitly and
 *     treats `7A 07` as an abort.
 *  2. **The module's own frame**, read by `FUN_006ccf80` into a *separate* buffer at `DAT_008ddc60`,
 *     byte by byte, with the length taken from the frame itself and a checksum verified at the end.
 *
 * Both stages size their read the same way, by a rule chosen from [Mode]. That rule is what
 * identifies the modes, and two of them are now certain rather than guessed:
 *
 *  - **[Mode.DS2]** takes the length from byte 1 and verifies that the XOR of every byte is zero.
 *    That is exactly DS2's `[address][length][data][XOR]`, checksum and all.
 *  - **[Mode.KWP]** takes it from the format byte's low six bits, or from byte 3 when those are
 *    zero, and verifies an *additive* checksum. That is ISO 14230.
 *
 * The success tests in `FUN_006cd1e4` agree: mode 2 succeeds on `0xA0` at index 2, DS2's positive
 * acknowledgement, and retries on `0xA1`; mode 4 fails on `0x7F` and recognises `0x78`, `0x21` and
 * `0x23` after it, which are KWP2000's responsePending, busyRepeatRequest and conditionsNotCorrect.
 *
 * Nothing here is invented. Where the executable is ambiguous this says so rather than choosing.
 */
object VendorTransaction {

    /**
     * How a reply's length is determined. The numbers are the values the executable stores in
     * `DAT_00a4cf20`, kept as-is so a log line can be compared against a disassembly directly.
     *
     * Modes 1 and 3 are not identified. They are transcribed because leaving a gap in a table that
     * the code fills completely would invite someone to guess at them later.
     */
    enum class Mode(val code: Int) {
        /** Length at index 2. Protocol family unknown. */
        ONE(1),

        /** Length at index 1, XOR checksum. **DS2.** */
        DS2(2),

        /** Length at index 3 plus five. Protocol family unknown. */
        THREE(3),

        /** Format byte, additive checksum. **KWP2000 / ISO 14230.** */
        KWP(4);

        companion object {
            fun of(code: Int): Mode? = entries.firstOrNull { it.code == code }
        }
    }

    /** The length a reader starts with, before the frame has said how long it is. */
    const val INITIAL_LENGTH = 4

    /**
     * The expected total length after [index] bytes have been read into [buf].
     *
     * Returns [current] unchanged when this index carries no length information, which is how the
     * original is written: it only ever assigns on specific indices and otherwise leaves the
     * running value alone.
     */
    fun expectedLength(mode: Mode, buf: ByteArray, index: Int, current: Int): Int {
        fun b(i: Int) = buf[i].toInt() and 0xFF
        return when (mode) {
            Mode.ONE -> if (index == 2) b(2) else current
            Mode.DS2 -> if (index == 1) b(1) else current
            Mode.THREE -> if (index == 3) b(3) + 5 else current
            Mode.KWP -> when {
                index == 0 && (b(0) and 0x3F) != 0 -> (b(0) and 0x3F) + 4
                index == 3 && (b(0) and 0x3F) == 0 -> b(3) + 5
                else -> current
            }
        }
    }

    /**
     * Whether the first [length] bytes of [buf] check out.
     *
     * Mode 4 sums and the rest exclusive-or, and in both cases the whole frame including its own
     * check byte must come to zero — the original accumulates across every byte and tests against
     * zero rather than comparing a computed value to a stored one.
     */
    fun checksumOk(mode: Mode, buf: ByteArray, length: Int): Boolean {
        if (length <= 0 || length > buf.size) return false
        var acc = 0
        for (i in 0 until length) {
            val v = buf[i].toInt() and 0xFF
            acc = if (mode == Mode.KWP) (acc + v) and 0xFF else acc xor v
        }
        return acc == 0
    }

    /** The two fixed openings `FUN_006ccdd4` recognises in the cable's acknowledgement. */
    enum class Ack {
        /** `77 07`: seven bytes, and the routine simply returns. */
        NOTHING_TO_SAY,

        /** `7A 07`: seven bytes, and the routine raises its abort flag. */
        ABORT,
    }

    /** What a sentinel opening means, or null when [buf] does not open with one. */
    fun ackOf(buf: ByteArray, offset: Int = 0): Ack? {
        if (offset + 1 >= buf.size) return null
        if ((buf[offset + 1].toInt() and 0xFF) != 0x07) return null
        return when (buf[offset].toInt() and 0xFF) {
            0x77 -> Ack.NOTHING_TO_SAY
            0x7A -> Ack.ABORT
            else -> null
        }
    }

    data class Frame(
        /** Where in the supplied bytes the frame was found to start. */
        val offset: Int,
        /** The frame itself, exactly as long as its own length rule said. */
        val bytes: ByteArray,
        /** True when the mode's checksum rule is satisfied. */
        val checksumOk: Boolean,
        /** Set when the frame opens with one of the two acknowledgement sentinels. */
        val ack: Ack?,
    )

    /**
     * Applies [mode]'s length rule to [data] starting at [offset], the way the original reads from
     * the wire.
     *
     * The original reads one byte at a time and stops when it has as many as the rule says; this
     * works over bytes already in hand, which is equivalent as long as enough of them arrived.
     * Returns null when they did not.
     */
    fun frameAt(mode: Mode, data: ByteArray, offset: Int = 0): Frame? {
        if (offset >= data.size) return null
        val buf = ByteArray(0x100)
        var expected = INITIAL_LENGTH
        var i = 0
        while (i < expected) {
            if (offset + i >= data.size) return null
            buf[i] = data[offset + i]
            expected = expectedLength(mode, buf, i, expected)
            if (expected > buf.size) return null
            i++
        }
        val bytes = buf.copyOf(expected)
        return Frame(offset, bytes, checksumOk(mode, bytes, expected), ackOf(bytes))
    }

    /**
     * Finds the first offset in [data] where [mode]'s rule yields a frame that checks out.
     *
     * Needed because the live replies carry three bytes ahead of the frame proper — `41 AA 12`
     * before `77 07 77 07 77 07 70` — which the executable does not account for: `FUN_006ca098`
     * writes without reading anything back, so the vendor's buffer should begin at the first byte
     * that arrives. Until that discrepancy is explained, assuming a fixed offset would bake the
     * confusion in, and resynchronising measures it instead: the offset this returns is the size of
     * whatever precedes the frame, and it should be reported rather than silently skipped.
     */
    fun resync(mode: Mode, data: ByteArray): Frame? {
        for (off in data.indices) {
            val f = frameAt(mode, data, off)
            if (f != null && f.checksumOk) return f
        }
        return null
    }
}
