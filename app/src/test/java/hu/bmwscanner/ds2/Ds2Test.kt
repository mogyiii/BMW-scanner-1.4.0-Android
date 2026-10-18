package hu.bmwscanner.ds2

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Tests for the DS2 framing and - more importantly - the resynchronising frame search.
 *
 * The search is the one piece of logic in this project that is both easy to get subtly wrong and
 * impossible to debug from a car park, so it is pinned down here rather than in the field.
 */
class Ds2Test {

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    // ---------------------------------------------------------------- framing

    @Test
    fun `builds the documented identification frame`() {
        // The widely quoted DS2 example: address 0x80, command 0x00, length 4, XOR checksum.
        assertArrayEquals(bytes(0x80, 0x04, 0x00, 0x84), Ds2.frame(0x80, bytes(0x00)))
    }

    @Test
    fun `length byte counts the whole frame including itself and the checksum`() {
        val f = Ds2.frame(0x12, bytes(0xAA, 0xBB, 0xCC))
        assertEquals(6, f.size)
        assertEquals(6, f[1].toInt() and 0xFF)
    }

    @Test
    fun `checksum is the xor of everything before it`() {
        val f = Ds2.frame(0x44, bytes(0x01, 0x02))
        val expected = (0x44 xor 0x05 xor 0x01 xor 0x02) and 0xFF
        assertEquals(expected, f[f.size - 1].toInt() and 0xFF)
    }

    // ---------------------------------------------------------------- hex parsing

    @Test
    fun `parses spaced, packed and prefixed hex alike`() {
        val want = bytes(0x12, 0x04, 0x00)
        assertArrayEquals(want, Ds2.parseHex("12 04 00"))
        assertArrayEquals(want, Ds2.parseHex("120400"))
        assertArrayEquals(want, Ds2.parseHex("0x12, 0x04, 0x00"))
    }

    // ---------------------------------------------------------------- resynchronising search

    @Test
    fun `finds a frame sitting at offset zero`() {
        val f = Ds2.frame(0x60, bytes(0xA0, 0x11))
        val got = Ds2.findFrame(f)
        assertNotNull(got)
        assertEquals(0, got!!.offset)
        assertArrayEquals(f, got.frame)
    }

    @Test
    fun `finds a frame behind one leading junk byte`() {
        // This is the case that broke the first field run: a transceiver emitting a spurious byte
        // before the real traffic pushes every field one place along.
        val f = Ds2.frame(0x60, bytes(0xA0, 0x11))
        val capture = bytes(0xFF) + f
        val got = Ds2.findFrame(capture)
        assertNotNull(got)
        assertEquals(1, got!!.offset)
        assertArrayEquals(f, got.frame)
    }

    @Test
    fun `finds a reply that follows the echo of our request`() {
        val request = Ds2.frame(0x60, bytes(0x00))
        val reply = Ds2.frame(0x60, bytes(0xA0, 0x12, 0x34))
        val capture = request + reply

        // Searching from scratch would latch onto the echo, which is itself a valid frame.
        val naive = Ds2.findFrame(capture)
        assertEquals(0, naive!!.offset)

        // Searching past the echo finds the actual reply, which is what sendRaw does.
        val got = Ds2.findFrame(capture, request.size)
        assertNotNull(got)
        assertEquals(request.size, got!!.offset)
        assertArrayEquals(reply, got.frame)
    }

    @Test
    fun `rejects a frame whose checksum is wrong`() {
        val f = Ds2.frame(0x60, bytes(0xA0, 0x11))
        f[f.size - 1] = (f[f.size - 1].toInt() xor 0xFF).toByte()
        assertNull(Ds2.findFrame(f))
    }

    @Test
    fun `rejects a truncated frame whose length byte overruns the buffer`() {
        // Length says 8 bytes but only 4 are present.
        assertNull(Ds2.findFrame(bytes(0x60, 0x08, 0x00, 0x68)))
    }

    @Test
    fun `prefers a frame from the address we asked`() {
        val other = Ds2.frame(0x11, bytes(0xA0))
        val wanted = Ds2.frame(0x60, bytes(0xA0))
        val capture = other + wanted

        val got = Ds2.findFrame(capture, 0, preferAddress = 0x60)
        assertNotNull(got)
        assertEquals(other.size, got!!.offset)
        assertArrayEquals(wanted, got.frame)
    }

    @Test
    fun `falls back to any valid frame when the preferred address is absent`() {
        val other = Ds2.frame(0x11, bytes(0xA0))
        val got = Ds2.findFrame(other, 0, preferAddress = 0x60)
        assertNotNull(got)
        assertArrayEquals(other, got!!.frame)
    }

    @Test
    fun `finds nothing in noise`() {
        assertNull(Ds2.findFrame(bytes(0xFF, 0xFF, 0xFF, 0xFF, 0xFF)))
    }

    // ---------------------------------------------------------------- echo location

    @Test
    fun `locates our transmission inside a larger capture`() {
        val request = Ds2.frame(0x60, bytes(0x00))
        assertEquals(0, Ds2.indexOf(request, request))
        assertEquals(2, Ds2.indexOf(bytes(0xDE, 0xAD) + request, request))
        assertEquals(-1, Ds2.indexOf(bytes(0xDE, 0xAD), request))
    }

    // ---------------------------------------------------------------- presence rule

    @Test
    fun `a module counts as present only for a checksum-valid frame from the right address`() {
        val request = Ds2.frame(0x60, bytes(0x00))
        val reply = Ds2.frame(0x60, bytes(0xA0, 0x01))

        val good = Ds2Result(request, request + reply, reply, true, true, "", 0, 0, request.size)
        assert(Ds2.isPresent(0x60, good))

        // Right frame, but we asked a different address.
        assert(!Ds2.isPresent(0x61, good))

        // Nothing parsed.
        val empty = Ds2Result(request, ByteArray(0), null, false, false, "silence", 0, -1, -1)
        assert(!Ds2.isPresent(0x60, empty))
    }
}
