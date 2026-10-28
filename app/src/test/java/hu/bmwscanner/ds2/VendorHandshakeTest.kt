package hu.bmwscanner.ds2

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the announcement decode against the bytes actually recorded from the car.
 *
 * The sample below is not synthetic. It is what the cable sent after the vendor's DTR pulse at
 * 19200 8N1 on 2026-10-19 (run 7) and again, byte for byte, on 2026-10-27 (run 16). The project
 * read it as noise for nineteen runs and run 9 concluded in print that it was an analogue
 * transient, so the decode is worth holding still: if this test passes, that reading is refuted by
 * arithmetic rather than by argument.
 */
class VendorHandshakeTest {

    /** Run 7 and run 16, identical, eight days apart. */
    private val captured = byteArrayOf(
        0x9B.toByte(), 0xCD.toByte(), 0xAA.toByte(), 0xAF.toByte(), 0xAF.toByte(),
        0xD9.toByte(), 0xF5.toByte(), 0xA2.toByte(), 0x9B.toByte(), 0x17.toByte(),
        0x28.toByte(), 0xFE.toByte(), 0x72.toByte(), 0xD1.toByte(), 0x17.toByte(),
        0x4C.toByte(), 0x5E.toByte(), 0x80.toByte(), 0x38.toByte(), 0x09.toByte(),
        0xED.toByte(), 0x2E.toByte(), 0xB5.toByte(), 0xCF.toByte(), 0xAA.toByte(),
        0x07.toByte(), 0x2B.toByte(),
    )

    @Test
    fun `the captured burst is exactly the length the vendor reads`() {
        assertEquals(VendorHandshake.LENGTH, captured.size)
    }

    @Test
    fun `the captured burst satisfies the vendor's checksum`() {
        assertTrue(
            "XOR of all 27 bytes must be zero; a transient would not manage that",
            VendorHandshake.checksumOk(captured),
        )
    }

    @Test
    fun `decoding the captured burst yields the hardware identity from the vendor's own log`() {
        val r = VendorHandshake.decode(captured)
        assertNotNull("the captured burst must decode", r)
        assertEquals(0x9B, r!!.key)
        assertEquals(VendorHandshake.EXPECTED_IDENTITY, r.identity)
    }

    @Test
    fun `the identity is terminated, as a C string, by a zero byte`() {
        val r = VendorHandshake.decode(captured)!!
        assertEquals(0, r.decoded[VendorHandshake.IDENTITY_LENGTH + 1].toInt())
    }

    @Test
    fun `the remainder is the eighteen bytes after the identity`() {
        val r = VendorHandshake.decode(captured)!!
        assertEquals(18, r.remainder.size)
        assertArrayEquals(
            byteArrayOf(
                0x8C.toByte(), 0xB3.toByte(), 0x65, 0xE9.toByte(), 0x4A, 0x8C.toByte(),
                0xD7.toByte(), 0xC5.toByte(), 0x1B, 0xA3.toByte(), 0x92.toByte(), 0x76,
                0xB5.toByte(), 0x2E, 0x54, 0x31, 0x9C.toByte(), 0xB0.toByte(),
            ),
            r.remainder,
        )
    }

    @Test
    fun `a wrong length is rejected rather than decoded leniently`() {
        assertNull(VendorHandshake.decode(captured.copyOfRange(0, 26)))
        assertNull(VendorHandshake.decode(captured + byteArrayOf(0)))
    }

    @Test
    fun `a corrupted byte breaks the checksum and is rejected`() {
        val bad = captured.copyOf()
        bad[13] = (bad[13].toInt() xor 1).toByte()
        assertNull(VendorHandshake.decode(bad))
    }

    /**
     * The burst sampled at 9600 instead of 19200 is the same physical message read at the wrong
     * rate. It must not decode - otherwise the test would accept any plausible-looking noise.
     */
    @Test
    fun `the same burst misread at 9600 does not decode`() {
        val misread = byteArrayOf(
            0x4B, 0xEF.toByte(), 0x4F, 0xAC.toByte(), 0x2B, 0xE6.toByte(), 0x05, 0x41,
            0x03, 0x46, 0xEE.toByte(), 0x6C, 0x2F, 0xF7.toByte(),
        )
        assertNull(VendorHandshake.decode(misread))
    }
}
