package hu.bmwscanner.ds2

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the framing and scrambling against traffic recorded from the vendor software itself.
 *
 * The scrambled samples below were captured through the FTD2XX shim while `BMWScan140.exe` ran
 * *Car ident* and *Scan!* with no cable attached (run 20). They are the only ground truth this
 * project has for what the software actually sends, so the tests work from them rather than from
 * frames this code generated — otherwise they would only prove the implementation agrees with
 * itself.
 */
class VendorProtocolTest {

    /** 19200 8N1, the first of two identical ident frames. */
    private val identScrambled = byteArrayOf(0x41, 0xCC.toByte(), 0x72, 0x31, 0x6E)

    /** 19200 8N1, the second — same frame, later in the key stream. */
    private val identScrambledAgain = byteArrayOf(0xBA.toByte(), 0x45, 0xE5.toByte(), 0x88.toByte(), 0xE5.toByte())

    /** 9600 8E1 — the DS2 line setting — carrying the specially-handled 0x83F0 command. */
    private val busScrambled = byteArrayOf(
        0x72, 0x45, 0xE1.toByte(), 0x4E, 0x42, 0xA2.toByte(),
        0x7A, 0xEE.toByte(), 0x1B, 0x0A, 0x25,
    )

    @Test
    fun `the captured ident frame descrambles to a well-formed frame`() {
        val found = VendorProtocol.recoverFrame(identScrambled)
        assertEquals("exactly one key should fit", 1, found.size)
        val (key, plain) = found.single()
        assertEquals(0x42, key)
        assertArrayEquals(byteArrayOf(0x03, 0x41, 0xAA.toByte(), 0x12, 0x00), plain)
    }

    @Test
    fun `the second ident frame is the same frame, and the key has moved on by exactly its length`() {
        val (key1, plain1) = VendorProtocol.recoverFrame(identScrambled).single()
        val (key2, plain2) = VendorProtocol.recoverFrame(identScrambledAgain).single()

        assertArrayEquals("the software sent the same frame twice", plain1, plain2)
        assertEquals(
            "the key is not reset between frames",
            key2,
            VendorProtocol.advanceKey(key1, plain1.size),
        )
    }

    @Test
    fun `the captured bus frame carries the command the transmit routine singles out`() {
        val (key, plain) = VendorProtocol.recoverFrame(busScrambled).single()
        assertEquals(0x7B, key)
        assertEquals(0x83, plain[1].toInt() and 0xFF)
        assertEquals(0xF0, plain[2].toInt() and 0xFF)
        assertEquals(0x12, plain[3].toInt() and 0xFF)
        assertTrue(VendorProtocol.frameOk(plain))
    }

    @Test
    fun `rebuilding the captured frames from their fields reproduces them exactly`() {
        val (_, ident) = VendorProtocol.recoverFrame(identScrambled).single()
        assertArrayEquals(
            ident,
            VendorProtocol.buildFrame(VendorProtocol.Command.IDENT, 0x12),
        )

        val (_, bus) = VendorProtocol.recoverFrame(busScrambled).single()
        assertArrayEquals(
            bus,
            VendorProtocol.buildFrame(
                VendorProtocol.Command.BUS,
                0x12,
                bus.copyOfRange(4, bus.size - 1),
            ),
        )
    }

    @Test
    fun `scrambling a built frame with the recovered key reproduces the captured bytes`() {
        val frame = VendorProtocol.buildFrame(VendorProtocol.Command.IDENT, 0x12)
        val (onWire, nextKey) = VendorProtocol.scramble(frame, 0x42)
        assertArrayEquals(identScrambled, onWire)
        assertEquals(0xB9, nextKey)
    }

    @Test
    fun `scrambling is its own inverse`() {
        val frame = VendorProtocol.buildFrame(VendorProtocol.Command.BUS, 0x80, byteArrayOf(1, 2, 3))
        val (wire, _) = VendorProtocol.scramble(frame, 0x9B)
        val (back, _) = VendorProtocol.scramble(wire, 0x9B)
        assertArrayEquals(frame, back)
    }

    @Test
    fun `a frame with no payload is five bytes and still checksums`() {
        val f = VendorProtocol.buildFrame(0x1234, 0x56)
        assertEquals(5, f.size)
        assertEquals(3, f[0].toInt())
        assertTrue(VendorProtocol.frameOk(f))
    }

    @Test
    fun `a corrupted checksum is rejected`() {
        val f = VendorProtocol.buildFrame(VendorProtocol.Command.IDENT, 0x12)
        f[f.size - 1] = (f[f.size - 1].toInt() xor 1).toByte()
        assertTrue(!VendorProtocol.frameOk(f))
    }

    /**
     * The first reply the cable ever gave us, recorded on the car on 2026-10-28 after the handshake
     * and the replayed ident frame. Three bytes of plain echo, then seven bytes opening with the
     * `77 07` sentinel - exactly the length FUN_006ccdd4 assigns to that opening.
     */
    private val liveReply = byteArrayOf(
        0x41, 0xAA.toByte(), 0x12,
        0x77, 0x07, 0x77, 0x07, 0x77, 0x07, 0x70,
    )

    @Test
    fun `the live reply echoes the command and parameter in plain`() {
        val r = VendorProtocol.parseReply(liveReply, VendorProtocol.Command.IDENT, 0x12)!!
        assertEquals(VendorProtocol.Command.IDENT, r.command)
        assertEquals(0x12, r.parameter)
        assertTrue("the echo identifies the reply as ours", r.echoMatches)
    }

    @Test
    fun `the live reply body is seven bytes and opens with the 77 07 sentinel`() {
        val r = VendorProtocol.parseReply(liveReply, VendorProtocol.Command.IDENT, 0x12)!!
        assertEquals(7, r.body.size)
        assertEquals(VendorProtocol.Sentinel.SEVEN_A, r.sentinel)
    }

    @Test
    fun `an echo from a different command is reported as not ours`() {
        val r = VendorProtocol.parseReply(liveReply, 0x1234, 0x12)!!
        assertTrue(!r.echoMatches)
    }

    @Test
    fun `a body without a sentinel reports none rather than guessing`() {
        val raw = byteArrayOf(0x41, 0xAA.toByte(), 0x12, 0x01, 0x02, 0x03)
        val r = VendorProtocol.parseReply(raw, VendorProtocol.Command.IDENT, 0x12)!!
        assertEquals(null, r.sentinel)
        assertEquals(3, r.body.size)
    }
}
