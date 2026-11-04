/**
 * The FT232R, driven over WebUSB.
 *
 * A port of the Android app's `FtdiDevice`, which talks to the chip through its documented vendor
 * control requests rather than through any serial library. The same approach works unchanged in a
 * browser: WebUSB exposes exactly the control and bulk transfers the chip needs.
 *
 * Everything here that carries a number carries it because the number was measured. The read that
 * stops on silence rather than on a clock is the whole reason this project works at all - see
 * `readUntilQuiet`.
 */

const REQ_RESET          = 0x00;
const REQ_SET_MODEM_CTRL = 0x01;
const REQ_SET_FLOW_CTRL  = 0x02;
const REQ_SET_BAUD_RATE  = 0x03;
const REQ_SET_DATA       = 0x04;
const REQ_SET_LATENCY    = 0x09;

export const PARITY = { NONE: 0, ODD: 1, EVEN: 2 };

/**
 * Encodes a baud rate the way the FT232R's divider wants it.
 *
 * Straight from libftdi, and checked against its fifteen published reference values early in the
 * project: 19200 comes out `0x809C` and 9600 `0x4138`, which is what the genuine driver programs.
 */
export function encodeBaudDivisor(baudRate) {
  const fracCode = [0, 3, 2, 4, 1, 5, 6, 7];
  const eighths = Math.floor((8 * 3000000 + baudRate / 2) / baudRate);
  let divisor = Math.floor(eighths / 8) | (fracCode[eighths % 8] << 14);
  if (divisor === 1) divisor = 0;
  else if (divisor === 0x4001) divisor = 1;
  return { value: divisor & 0xffff, index: (divisor >> 16) & 0xff };
}

export class Ftdi {
  constructor(device) {
    this.device = device;
    this.pending = [];
    this.maxPacketSize = 64;
  }

  /** Asks the browser for the cable and opens it. Must be called from a user gesture. */
  static async request() {
    const device = await navigator.usb.requestDevice({
      filters: [{ vendorId: 0x0333, productId: 0x0137 }],
    });
    const ftdi = new Ftdi(device);
    await ftdi.open();
    return ftdi;
  }

  /** Reopens a device the browser already has permission for, if one is plugged in. */
  static async reopenKnown() {
    const list = await navigator.usb.getDevices();
    const device = list.find((d) => d.vendorId === 0x0333 && d.productId === 0x0137);
    if (!device) return null;
    const ftdi = new Ftdi(device);
    await ftdi.open();
    return ftdi;
  }

  async open() {
    await this.device.open();
    if (this.device.configuration === null) await this.device.selectConfiguration(1);
    const iface = this.device.configuration.interfaces[0];
    await this.device.claimInterface(iface.interfaceNumber);
    this.interfaceNumber = iface.interfaceNumber;

    for (const ep of iface.alternate.endpoints) {
      if (ep.direction === 'in') { this.epIn = ep.endpointNumber; this.maxPacketSize = ep.packetSize || 64; }
      else this.epOut = ep.endpointNumber;
    }
  }

  async close() {
    try { await this.device.releaseInterface(this.interfaceNumber); } catch (e) { /* already gone */ }
    try { await this.device.close(); } catch (e) { /* already gone */ }
  }

  async control(request, value, index = 0) {
    await this.device.controlTransferOut({
      requestType: 'vendor', recipient: 'device', request, value, index,
    });
  }

  async configure({ baudRate, parity, latencyMs = 1 }) {
    await this.control(REQ_RESET, 0);
    await this.control(REQ_SET_FLOW_CTRL, 0);
    await this.setBaudRate(baudRate);
    await this.setLineProperties(8, parity);
    await this.control(REQ_SET_LATENCY, latencyMs);
    await this.purge();
  }

  async setBaudRate(baudRate) {
    const { value, index } = encodeBaudDivisor(baudRate);
    await this.control(REQ_SET_BAUD_RATE, value, index);
  }

  /** Data bits in the low byte, parity in bits 8-10, stop bits in 11-13. One stop bit is zero. */
  async setLineProperties(dataBits, parity) {
    await this.control(REQ_SET_DATA, dataBits | (parity << 8));
  }

  /** DTR is bit 0 with bit 8 as its enable; RTS is bit 1 with bit 9. */
  async setDtr(on) {
    await this.control(REQ_SET_MODEM_CTRL, (on ? 0x0101 : 0x0100));
  }

  async purge() {
    await this.control(REQ_RESET, 1);   // receive buffer
    await this.control(REQ_RESET, 2);   // transmit buffer
    this.pending.length = 0;
  }

  async write(bytes) {
    await this.device.transferOut(this.epOut, new Uint8Array(bytes));
  }

  /**
   * Pulls whatever the chip has, stripping the two status bytes it puts at the head of every packet.
   */
  async pump(timeoutMs = 20) {
    let result;
    try {
      result = await this.device.transferIn(this.epIn, this.maxPacketSize * 16);
    } catch (e) {
      return 0;
    }
    if (!result.data || result.data.byteLength < 2) return 0;
    const raw = new Uint8Array(result.data.buffer);
    let produced = 0;
    for (let off = 0; off + 2 <= raw.length; off += this.maxPacketSize) {
      const packet = Math.min(this.maxPacketSize, raw.length - off);
      for (let i = off + 2; i < off + packet; i++) { this.pending.push(raw[i]); produced++; }
    }
    return produced;
  }

  /**
   * Reads until the line has been quiet for `quietMs`, giving up after `overallTimeoutMs`.
   *
   * **The quiet period is 800 ms and that number is the whole answer.** The cable answers some
   * commands in more than one block - `0xB318` sends two seven-byte sentinels, `0x83F0` eleven
   * bytes - and the later block arrives a long way behind the first. At 200 ms every reply came
   * back cut in half and the remainder was purged before the next command, so each answer was
   * credited to the wrong question and nothing ever made sense. At 800 ms the byte counts match
   * what the genuine Windows driver sees exactly.
   */
  async readUntilQuiet(quietMs = 800, overallTimeoutMs = 3000) {
    const out = [];
    const deadline = Date.now() + overallTimeoutMs;
    let lastData = Date.now();
    while (Date.now() < deadline) {
      while (this.pending.length) { out.push(this.pending.shift()); lastData = Date.now(); }
      if (out.length && Date.now() - lastData >= quietMs) break;
      if (await this.pump() > 0) lastData = Date.now();
      else await new Promise((r) => setTimeout(r, 10));
    }
    while (this.pending.length) out.push(this.pending.shift());
    return Uint8Array.from(out);
  }

  /** Reads exactly `count` bytes, or fewer if the timeout runs out. */
  async readExactly(count, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.length < count && Date.now() < deadline) {
      if (await this.pump() === 0) await new Promise((r) => setTimeout(r, 10));
    }
    const n = Math.min(count, this.pending.length);
    return Uint8Array.from(this.pending.splice(0, n));
  }
}
