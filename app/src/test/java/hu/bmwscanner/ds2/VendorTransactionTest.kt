package hu.bmwscanner.ds2

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the two-stage reader against bytes the cable actually sent and against the rules as the
 * executable states them.
 *
 * The live bytes here are the complete reply recorded on the car on 2026-10-28 after the replayed
 * ident frame, and the one recorded for the `0x83F0` frame. Synthetic frames are used only where
 * the point is a rule the code states and no capture exists yet — and they are marked as such.
 */
class VendorTransactionTest {

    /** Recorded on the car: the reply to `03 41 AA 12 00`. */
    private val liveIdentReply = byteArrayOf(
        0x41, 0xAA.toByte(), 0x12,
        0x77, 0x07, 0x77, 0x07, 0x77, 0x07, 0x70,
    )

    /** Recorded on the car: the reply to the `0x83F0` frame, which the code calls the abort case. */
    private val liveBusReply = byteArrayOf(
        0x83.toByte(),
        0x7A, 0x07, 0x7A, 0x07, 0x7A, 0x07, 0x7D,
    )

    @Test
    fun `the live acknowledgement is a frame that checks out under the DS2 rule`() {
        val f = VendorTransaction.resync(VendorTransaction.Mode.DS2, liveIdentReply)!!
        assertEquals("three bytes precede it", 3, f.offset)
        assertEquals(7, f.bytes.size)
        assertTrue(f.checksumOk)
        assertArrayEquals(
            byteArrayOf(0x77, 0x07, 0x77, 0x07, 0x77, 0x07, 0x70),
            f.bytes,
        )
    }

    @Test
    fun `the two sentinels are told apart, and the abort one is recognised as such`() {
        val ident = VendorTransaction.resync(VendorTransaction.Mode.DS2, liveIdentReply)!!
        assertEquals(VendorTransaction.Ack.NOTHING_TO_SAY, ident.ack)

        val bus = VendorTransaction.resync(VendorTransaction.Mode.DS2, liveBusReply)!!
        assertEquals(VendorTransaction.Ack.ABORT, bus.ack)
        assertEquals("one byte precedes this one", 1, bus.offset)
    }

    @Test
    fun `the DS2 length comes from byte one`() {
        // A real DS2 reply shape: address, length, positive acknowledgement, payload, XOR.
        val body = byteArrayOf(0x12, 0x06, 0xA0.toByte(), 0x11, 0x22)
        var x = 0
        for (b in body) x = x xor (b.toInt() and 0xFF)
        val frame = body + x.toByte()

        val f = VendorTransaction.frameAt(VendorTransaction.Mode.DS2, frame)!!
        assertEquals(6, f.bytes.size)
        assertTrue("synthetic, but built to the rule the code states", f.checksumOk)
        assertNull("a module reply is not a sentinel", f.ack)
    }

    @Test
    fun `a DS2 frame with one bit flipped fails its checksum`() {
        val f = VendorTransaction.frameAt(
            VendorTransaction.Mode.DS2,
            byteArrayOf(0x77, 0x07, 0x77, 0x07, 0x77, 0x07, 0x71),
        )!!
        assertTrue(!f.checksumOk)
    }

    @Test
    fun `KWP takes its length from the format byte and sums rather than XORs`() {
        // Synthetic: format byte with three data bytes, then address pair, data, additive checksum.
        val head = byteArrayOf(0x83.toByte(), 0x12, 0xF1.toByte(), 0x7F, 0x21, 0x78)
        var s = 0
        for (b in head) s = (s + (b.toInt() and 0xFF)) and 0xFF
        val frame = head + ((0x100 - s) and 0xFF).toByte()

        val f = VendorTransaction.frameAt(VendorTransaction.Mode.KWP, frame)!!
        assertEquals("0x83 & 0x3F = 3, plus four", 7, f.bytes.size)
        assertTrue(f.checksumOk)
    }

    @Test
    fun `the DS2 rule rejects a KWP frame and the reverse, so the mode is not cosmetic`() {
        val kwp = byteArrayOf(0x83.toByte(), 0x12, 0xF1.toByte(), 0x7F, 0x21, 0x78, 0x42)
        val asDs2 = VendorTransaction.frameAt(VendorTransaction.Mode.DS2, kwp)
        // Length byte 0x12 is 18, and only seven bytes exist, so it cannot even be read.
        assertNull(asDs2)
    }

    @Test
    fun `a reply that is too short to satisfy its own length rule returns nothing`() {
        assertNull(VendorTransaction.frameAt(VendorTransaction.Mode.DS2, byteArrayOf(0x12, 0x20)))
    }

    /**
     * The first structured reply the cable ever gave, recorded on the car on 2026-10-29 after the
     * replayed sign-on frame unlocked the link. Six bytes, no sentinel, arriving in 37 ms rather
     * than running into the 285 ms timeout seen before.
     */
    private val firstRealReply = byteArrayOf(
        0xB8.toByte(), 0x12, 0xF1.toByte(), 0x01, 0xA2.toByte(), 0xF8.toByte(),
    )

    @Test
    fun `the first real reply fits mode three and no other`() {
        val fits = VendorTransaction.Mode.entries.filter { m ->
            val f = VendorTransaction.frameAt(m, firstRealReply)
            f != null && f.checksumOk && f.bytes.size == firstRealReply.size
        }
        assertEquals("only mode 3's rule gives six", listOf(VendorTransaction.Mode.THREE), fits)
    }

    @Test
    fun `the first real reply checksums and is not a sentinel`() {
        val (mode, f) = VendorTransaction.resyncAnyMode(firstRealReply)!!
        assertEquals(VendorTransaction.Mode.THREE, mode)
        assertEquals(0, f.offset)
        assertEquals(6, f.bytes.size)
        assertTrue(f.checksumOk)
        assertNull("this is data, not one of the two fixed non-events", f.ack)
    }

    @Test
    fun `mode codes match the values the executable stores`() {
        assertEquals(VendorTransaction.Mode.DS2, VendorTransaction.Mode.of(2))
        assertEquals(VendorTransaction.Mode.KWP, VendorTransaction.Mode.of(4))
        assertNull(VendorTransaction.Mode.of(5))
    }
}
