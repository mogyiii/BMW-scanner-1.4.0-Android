"""Decode a VirtualBox USB capture (DLT_USB_LINUX_MMAPPED, 220) of FTDI traffic."""
import struct, sys, collections

PATH = sys.argv[1] if len(sys.argv) > 1 else "usbcap1.pcap"
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 150

FTDI_REQ = {
    0x00: "FTDI_RESET", 0x01: "FTDI_MODEM_CTRL", 0x02: "FTDI_FLOW_CTRL",
    0x03: "FTDI_BAUD", 0x04: "FTDI_LINE", 0x05: "FTDI_MODEM_STATUS",
    0x06: "FTDI_EVENT_CHAR", 0x07: "FTDI_ERROR_CHAR", 0x09: "FTDI_LATENCY",
    0x0A: "FTDI_GET_LATENCY", 0x0B: "FTDI_BITMODE", 0x0C: "FTDI_READ_PINS",
    0x90: "FTDI_READ_EEPROM", 0x91: "FTDI_WRITE_EEPROM", 0x92: "FTDI_ERASE_EEPROM",
}
STD_REQ = {0x00: "GET_STATUS", 0x05: "SET_ADDRESS", 0x06: "GET_DESCRIPTOR",
           0x09: "SET_CONFIGURATION", 0x0B: "SET_INTERFACE"}


def blocks(data):
    off, endian = 0, "<"
    while off + 12 <= len(data):
        bt = struct.unpack_from(endian + "I", data, off)[0]
        bl = struct.unpack_from(endian + "I", data, off + 4)[0]
        if bt == 0x0A0D0D0A:
            endian = "<" if struct.unpack_from("<I", data, off + 8)[0] == 0x1A2B3C4D else ">"
            bl = struct.unpack_from(endian + "I", data, off + 4)[0]
        if bl < 12 or off + bl > len(data):
            break
        yield bt, data[off + 8: off + bl - 4], endian
        off += bl


def decode_baud(value, index):
    d = value | ((index & 0xFF) << 16)
    frac = {0: 0.0, 1: 0.5, 2: 0.25, 3: 0.125, 4: 0.375, 5: 0.625, 6: 0.75, 7: 0.875}
    integer, f = d & 0x3FFF, frac.get((d >> 14) & 0x7, 0.0)
    if integer == 0 and f == 0:
        return 3000000
    if integer == 1 and f == 0:
        return 2000000
    t = integer + f
    return int(round(3000000 / t)) if t else 0


def describe_setup(s):
    bm, br, wval, widx, wlen = struct.unpack("<BBHHH", s)
    vendor = (bm & 0x60) == 0x40
    name = FTDI_REQ.get(br, "req0x%02X" % br) if vendor else STD_REQ.get(br, "std0x%02X" % br)
    extra = ""
    if vendor:
        if br == 0x03:
            extra = "  -> %d baud" % decode_baud(wval, widx)
        elif br == 0x04:
            bits, par, stop = wval & 0xFF, (wval >> 8) & 0x7, (wval >> 11) & 0x7
            extra = "  -> %d%s%s%s" % (bits, "NOEMS"[par] if par < 5 else "?",
                                       {0: "1", 1: "1.5", 2: "2"}.get(stop, "?"),
                                       "  BREAK" if wval & 0x4000 else "")
        elif br == 0x0B:
            extra = "  -> mask=0x%02X mode=0x%02X" % (wval & 0xFF, (wval >> 8) & 0xFF)
        elif br == 0x01:
            extra = "  -> modem 0x%04X" % wval
        elif br == 0x00:
            extra = "  -> %s" % {0: "SIO reset", 1: "purge RX", 2: "purge TX"}.get(wval, "?")
        elif br == 0x09:
            extra = "  -> %d ms" % wval
        elif br == 0x90:
            extra = "  -> word 0x%02X" % widx
        elif br == 0x02:
            extra = "  -> flow 0x%04X" % widx
    return name, "%-18s val=0x%04X idx=0x%04X len=%-3d%s" % (name, wval, widx, wlen, extra)


def main():
    data = open(PATH, "rb").read()
    pkts = []
    for bt, body, endian in blocks(data):
        if bt == 6:
            caplen = struct.unpack_from(endian + "I", body, 12)[0]
            pkts.append(body[20:20 + caplen])

    ctrl = collections.Counter()
    events, tx, rx = [], bytearray(), bytearray()
    t0 = None

    for p in pkts:
        if len(p) < 64:
            continue
        ev = chr(p[8])
        xtype = p[9]
        ep = p[10]
        setup_flag = p[14]
        ts = struct.unpack_from("<q", p, 16)[0] + struct.unpack_from("<i", p, 24)[0] / 1e6
        if t0 is None:
            t0 = ts
        rel = ts - t0
        length = struct.unpack_from("<I", p, 32)[0]
        lencap = struct.unpack_from("<I", p, 36)[0]
        payload = p[64:64 + lencap]
        dev_to_host = bool(ep & 0x80)

        if xtype == 2 and ev == "S" and setup_flag == 0:
            name, desc = describe_setup(p[40:48])
            ctrl[name] += 1
            events.append("%8.3f  CTRL %s" % (rel, desc))
        elif xtype == 2 and ev == "C" and payload:
            events.append("%8.3f       reply %s" % (rel, payload[:32].hex(" ")))
        elif xtype == 3:
            if dev_to_host and ev == "C" and payload:
                body_ = payload[2:]
                st = "%02X%02X" % (payload[0], payload[1])
                if body_:
                    rx += body_
                    events.append("%8.3f  BULK IN  [%s] %s" % (rel, st, body_.hex(" ")))
            elif not dev_to_host and ev == "S" and payload:
                tx += payload
                events.append("%8.3f  BULK OUT %s" % (rel, payload.hex(" ")))

    print("packets=%d  events=%d" % (len(pkts), len(events)))
    print("\n=== control request totals ===")
    for k, v in ctrl.most_common():
        print("  %-20s %d" % (k, v))
    print("\n=== first %d events ===" % LIMIT)
    for e in events[:LIMIT]:
        print("  " + e)
    print("\n=== totals ===")
    print("  TX to cable:   %d bytes" % len(tx))
    print("  RX from cable: %d bytes" % len(rx))
    if tx:
        print("  TX head: %s" % tx[:64].hex(" "))
    if rx:
        print("  RX head: %s" % rx[:64].hex(" "))


main()
