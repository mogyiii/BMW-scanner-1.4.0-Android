/*
 * FTD2XX shim - pretends the BMW Scanner cable is attached, logs what the vendor software does.
 *
 * See README.md for why this exists. In short: BMWScan140.exe reaches the cable through FTDI's
 * ordinary userspace library, and Windows loads a DLL from the application directory before the
 * system one, so replacing it needs no driver, no USB and nothing signed.
 *
 * Written against the Win32 API alone - no stdio, no malloc, no C string functions. Formatting goes
 * through wsprintfA from user32 and files through CreateFileA, so the import list is KERNEL32,
 * USER32 and msvcrt (the last only for mingw's own start-up glue). All three ship with Windows XP,
 * where the isolated VM lives and where the vendor software is known to run, and keeping the
 * library surface that small means a packed executable's start-up is not the place to discover a
 * runtime initialisation problem. The cost is doing our own formatting, which is a few lines.
 */

#include <windows.h>

#define FT_OK 0
#define FT_INVALID_HANDLE 1
#define FT_DEVICE_NOT_FOUND 2
#define FT_DEVICE_NOT_OPENED 3
#define FT_IO_ERROR 4

typedef ULONG FT_STATUS;
typedef PVOID FT_HANDLE;

/* The one handle we ever hand out. Its value is arbitrary but must be non-NULL. */
#define SHIM_HANDLE ((FT_HANDLE)0x5C4B1E01)

static CRITICAL_SECTION g_lock;
static BOOL g_lockReady = FALSE;
static CHAR g_dir[MAX_PATH];          /* directory this DLL was loaded from */
static CHAR g_logPath[MAX_PATH];
static CHAR g_rxPath[MAX_PATH];

/* Current line settings, so the log can say what the software meant. */
static ULONG g_baud = 0;
static UCHAR g_bits = 8, g_stop = 0, g_parity = 0;

/* Bytes still to be handed to FT_Read, refilled from ftd2xx-rx.hex when that file changes. */
static BYTE g_rx[4096];
static DWORD g_rxLen = 0, g_rxPos = 0;
static FILETIME g_rxStamp;

/*
 * The cable's real EEPROM, all 64 words, exactly as dumped from the hardware in run 2
 * (docs/field-logs/2026-10-18-run2.log). Serving the genuine contents matters: the start-up reads
 * the whole thing, and the strings in it are the manufacturer, description and serial the software
 * displays. Inventing plausible values would risk failing a check we cannot see.
 */
static const WORD g_eeprom[64] = {
    0x4000, 0x0333, 0x0137, 0x0000, 0x2D80, 0x0008, 0x0000, 0x0E98,
    0x22A6, 0x12C8, 0xAAAA, 0x0006, 0x030E, 0x0050, 0x0041, 0x0053,
    0x004F, 0x0046, 0x0054, 0x0322, 0x0042, 0x004D, 0x0057, 0x0020,
    0x0053, 0x0063, 0x0061, 0x006E, 0x006E, 0x0065, 0x0072, 0x0020,
    0x0056, 0x0031, 0x0034, 0x0078, 0x0312, 0x0050, 0x0041, 0x0035,
    0x0042, 0x0047, 0x0036, 0x0034, 0x0059, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x6206,
};

static const CHAR g_serial[] = "PA5BG64Y";
static const CHAR g_desc[] = "BMW Scanner V14x";
static const CHAR g_manuf[] = "PASOFT";

/* ------------------------------------------------------------------ logging */

static void logRaw(const CHAR *text, int len)
{
    HANDLE h;
    DWORD written;
    if (len < 0) {
        len = 0;
        while (text[len]) len++;
    }
    h = CreateFileA(g_logPath, FILE_APPEND_DATA, FILE_SHARE_READ, NULL,
                    OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    SetFilePointer(h, 0, NULL, FILE_END);
    WriteFile(h, text, (DWORD)len, &written, NULL);
    CloseHandle(h);
}

/* wsprintfA lives in user32 and has no CRT dependency; it is enough for what we print. */
static void shimLog(const CHAR *fmt, ...)
{
    CHAR buf[1024];
    CHAR line[1100];
    SYSTEMTIME st;
    va_list ap;
    int n;

    va_start(ap, fmt);
    wvsprintfA(buf, fmt, ap);
    va_end(ap);

    GetLocalTime(&st);
    n = wsprintfA(line, "%02d:%02d:%02d.%03d  %s\r\n",
                  st.wHour, st.wMinute, st.wSecond, st.wMilliseconds, buf);
    logRaw(line, n);
}

static DWORD g_emptyReads = 0;

/* Prints how many empty polls went by, so a burst of them costs one line instead of thousands. */
static void flushEmptyReads(void)
{
    if (!g_emptyReads) return;
    shimLog("   ... %u empty read(s) while waiting", g_emptyReads);
    g_emptyReads = 0;
}

/* Hex for a byte buffer, chunked so one enormous write cannot overflow the line buffer. */
static void logBytes(const CHAR *prefix, const BYTE *data, DWORD len)
{
    CHAR line[1024];
    DWORD i = 0;
    while (i < len) {
        int n = wsprintfA(line, "    %s[%u..]", prefix, i);
        DWORD j;
        for (j = i; j < len && j < i + 32; j++)
            n += wsprintfA(line + n, " %02X", data[j]);
        n += wsprintfA(line + n, "\r\n");
        logRaw(line, n);
        i = j;
    }
}

/* ------------------------------------------------------------------ reply file */

static int hexNibble(CHAR c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/*
 * Reloads ftd2xx-rx.hex if its timestamp changed.
 *
 * Re-reading rather than loading once is the point of the whole file: the vendor software waits for
 * the cable to announce itself, we do not know what that announcement is, and the cheapest way to
 * search is to edit a text file and press the button again. A restart per attempt would make the
 * search tedious enough to abandon.
 */
static void refreshRx(void)
{
    WIN32_FILE_ATTRIBUTE_DATA fad;
    HANDLE h;
    DWORD got = 0, i;
    BYTE raw[8192];
    int hi = -1;

    if (!GetFileAttributesExA(g_rxPath, GetFileExInfoStandard, &fad)) return;
    if (fad.ftLastWriteTime.dwLowDateTime == g_rxStamp.dwLowDateTime &&
        fad.ftLastWriteTime.dwHighDateTime == g_rxStamp.dwHighDateTime) return;
    g_rxStamp = fad.ftLastWriteTime;

    h = CreateFileA(g_rxPath, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    ReadFile(h, raw, sizeof(raw), &got, NULL);
    CloseHandle(h);

    g_rxLen = 0;
    g_rxPos = 0;
    for (i = 0; i < got && g_rxLen < sizeof(g_rx); i++) {
        int v;
        if (raw[i] == '#') {                       /* comment to end of line */
            while (i < got && raw[i] != '\n') i++;
            hi = -1;
            continue;
        }
        v = hexNibble((CHAR)raw[i]);
        if (v < 0) { hi = -1; continue; }
        if (hi < 0) hi = v;
        else { g_rx[g_rxLen++] = (BYTE)((hi << 4) | v); hi = -1; }
    }
    shimLog("rx file reloaded: %u byte(s) queued", g_rxLen);
}

/* ------------------------------------------------------------------ the search */

/*
 * Candidate announcements, tried one per program launch.
 *
 * The first log told us exactly what the software is waiting for: after setting 19200 8N1,
 * purging, and pulsing DTR for 100 ms, it calls FT_Read for **one byte at a time**, forever. It is
 * waiting for the cable to speak first and we do not know what it wants to hear.
 *
 * Editing a hex file by hand inside an isolated VM, once per guess, would make that search
 * miserable. So the shim keeps an index in ftd2xx-state.txt, serves the next candidate on each
 * load, and logs which one it used. The search becomes: start the program, close it, start it
 * again. An explicit ftd2xx-rx.hex still wins if it has content, so a hand-made guess can jump the
 * queue.
 *
 * The ordering is deliberate. First the bytes the *real cable* produces - captured on the car at
 * 19200 after exactly this DTR pulse, reproduced byte-for-byte eight days apart in runs 7 and 16.
 * Run 9 concluded that burst is an analogue transient rather than a message, on the strength of its
 * edge timing; if the vendor software accepts it as a sign-on, that conclusion was about the wrong
 * question and this is the fastest way to find out. Then the hardware string the software prints in
 * its own 2009 session log, "V144Bn9", which it cannot have invented, in the obvious framings.
 */
typedef struct {
    const CHAR *name;
    const BYTE *data;
    DWORD len;
} Candidate;

/* 19200 NONE, after the vendor's own DTR pulse - runs 7 and 16, identical. */
static const BYTE cand_burst[] = {
    0x9B, 0xCD, 0xAA, 0xAF, 0xAF, 0xD9, 0xF5, 0xA2, 0x9B, 0x17, 0x28, 0xFE, 0x72, 0xD1,
    0x17, 0x4C, 0x5E, 0x80, 0x38, 0x09, 0xED, 0x2E, 0xB5, 0xCF, 0xAA, 0x07, 0x2B,
};
static const BYTE cand_hw[] = { 'V','1','4','4','B','n','9' };
static const BYTE cand_hwCrLf[] = { 'V','1','4','4','B','n','9', 0x0D, 0x0A };
static const BYTE cand_hwLen[] = { 0x07, 'V','1','4','4','B','n','9' };
static const BYTE cand_hwNul[] = { 'V','1','4','4','B','n','9', 0x00 };
static const BYTE cand_sync55[] = { 0x55 };
static const BYTE cand_syncAA[] = { 0xAA };
static const BYTE cand_ack[] = { 0x06 };
static const BYTE cand_desc[] = { 'B','M','W',' ','S','c','a','n','n','e','r',' ','v','1','4','x' };
static const BYTE cand_v14[] = { 'V','1','4','4' };

static const Candidate g_candidates[] = {
    { "(nothing - the baseline)",            NULL,         0 },
    { "the real cable's burst at 19200",     cand_burst,   sizeof(cand_burst) },
    { "\"V144Bn9\"",                         cand_hw,      sizeof(cand_hw) },
    { "\"V144Bn9\" + CR LF",                 cand_hwCrLf,  sizeof(cand_hwCrLf) },
    { "length byte 07 + \"V144Bn9\"",        cand_hwLen,   sizeof(cand_hwLen) },
    { "\"V144Bn9\" + NUL",                   cand_hwNul,   sizeof(cand_hwNul) },
    { "\"V144\"",                            cand_v14,     sizeof(cand_v14) },
    { "0x55 sync byte",                      cand_sync55,  sizeof(cand_sync55) },
    { "0xAA",                                cand_syncAA,  sizeof(cand_syncAA) },
    { "0x06 ACK",                            cand_ack,     sizeof(cand_ack) },
    { "\"BMW Scanner v14x\"",                cand_desc,    sizeof(cand_desc) },
};
#define CANDIDATE_COUNT (sizeof(g_candidates) / sizeof(g_candidates[0]))

static CHAR g_statePath[MAX_PATH];
static DWORD g_candIndex = 0;

/* Reads the index, uses it, writes back the next one. A missing or unreadable file means zero. */
static DWORD nextCandidateIndex(void)
{
    HANDLE h;
    CHAR buf[32];
    DWORD got = 0, i, idx = 0, n;

    h = CreateFileA(g_statePath, GENERIC_READ, FILE_SHARE_READ, NULL,
                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        ReadFile(h, buf, sizeof(buf) - 1, &got, NULL);
        CloseHandle(h);
        for (i = 0; i < got; i++) {
            if (buf[i] < '0' || buf[i] > '9') break;
            idx = idx * 10 + (DWORD)(buf[i] - '0');
        }
    }
    if (idx >= CANDIDATE_COUNT + 256) idx = 0;

    n = (DWORD)wsprintfA(buf, "%u", (idx + 1) % (CANDIDATE_COUNT + 256));
    h = CreateFileA(g_statePath, GENERIC_WRITE, 0, NULL,
                    CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        DWORD wrote;
        WriteFile(h, buf, n, &wrote, NULL);
        CloseHandle(h);
    }
    return idx;
}

/*
 * How many repeats of a swept byte to queue.
 *
 * The point of serving more than one is the measurement. The software reads a single byte at a
 * time, which says it checks as it goes: a wrong first byte and it gives up, a right one and it
 * asks for another. So the number of bytes it *consumes* is the signal, and queuing a long run
 * means a correct first byte has somewhere to go. One byte would make a hit look like a miss.
 */
#define SWEEP_REPEATS 64

/*
 * The real cable's announcement, 27 bytes, exactly as it came off the wire on the car.
 *
 * Recorded 2026-10-28 (field-logs/2026-10-28-run23-handshake-complete-on-car.log). XOR of all 27
 * is zero, byte 0 is the scrambling key, and bytes 1..7 decode to "V144Bn9" - the same identity the
 * manufacturer's own shipped session log prints. This replaces the "BMW Scanner v14x" guess that
 * earlier runs used: that string got the software to its main window, but it is not what the cable
 * says, so everything the software built afterwards was built on a fiction.
 */
static const BYTE g_announce[27] = {
    0x9B, 0xCD, 0xAA, 0xAF, 0xAF, 0xD9, 0xF5, 0xA2, 0x9B, 0x17, 0x28, 0xFE, 0x72, 0xD1,
    0x17, 0x4C, 0x5E, 0x80, 0x38, 0x09, 0xED, 0x2E, 0xB5, 0xCF, 0xAA, 0x07, 0x2B
};

/* Scrambling key, tracked exactly as FUN_006ccdd4 does: announcement byte 0, plus 0x4B per
 * transmitted byte, never reset between frames. Tracking it here is what makes the log show
 * plaintext commands instead of hex that has to be brute-forced afterwards. */
static BYTE g_key = 0x9B;

/* Declared here because rearmCandidate() below clears a half-built frame, and the frame machinery
 * is defined further down next to the code that uses it. */
static void resetFrame(void);

/*
 * Replies the real cable was observed giving, and one substitute.
 *
 * The distinction matters and is kept visible in the log. Two of these are evidence: the cable gave
 * them, on the car, to those exact requests. The third is a **substitute** - the `77 07` reply,
 * reused for requests whose real answer nobody has measured yet.
 *
 * Why substitute anything at all: `77 07` is the one reply FUN_006ccdd4 treats as a benign
 * non-event and simply returns from, whereas `7A 07` raises its abort flag and `0x83F0`'s own
 * failure path tears the session down. Feeding the benign one to unknown requests keeps the
 * software running and emitting further commands, and **the commands it emits are the evidence
 * being collected here.** Its replies are a fixture; nothing downstream of them may be treated as
 * the cable's behaviour. Anything logged as SUBSTITUTED is a request to go and ask the real cable.
 */
/*
 * Recorded on the car on 2026-10-29 (run 33 and run 34), on an **authenticated** link - that is,
 * after the sign-on frame below had been sent. That qualification matters: the same ident frame on
 * an unauthenticated link returns `41 AA 12 77 07 ...` instead, with a three-byte plaintext echo in
 * front, so these are the cable's answers in the state the vendor software is always in and never
 * the ones an idle cable gives.
 *
 * The ident reply was sent three times in one session and came back byte for byte identical each
 * time, so it is stable rather than a snapshot of something changing.
 */
static const BYTE reply_signon[]  = { 0x77, 0x07, 0x77, 0x07, 0x77, 0x07, 0x70 };
static const BYTE reply_ident[]   = { 0xB8, 0x12, 0xF1, 0x01, 0xA2, 0xF8 };
/*
 * The 0x83F0 reply, recorded on the car on 2026-10-29 at all sixty-three addresses with the
 * connection rebuilt for each - run 39.
 *
 * The earlier eleven-byte fixture served here came from run 34, on a link that had already decayed
 * after three frames, so it was a recording of the cable misbehaving. This is the clean one.
 *
 * Two bytes vary with the address and the rest never do. Byte 5 is the parameter we sent XORed with
 * 0xC9 - verified on all sixty-three - and byte 12 is some check over the result, which is filled
 * in here from a table because the rule producing it is not known. The template holds the invariant
 * bytes; `busReplyFor` patches in the two that move.
 */
static const BYTE reply_bus_template[13] = {
    0x65, 0x3D, 0x02, 0xDA, 0x37, 0x00, 0xBE, 0xA9, 0x08, 0xBF, 0x13, 0x5D, 0x00
};

/* Address, then the trailing byte observed for it. Straight from the run-39 log. */
static const BYTE g_busTail[][2] = {
    {0x00,0x5D},{0x08,0x65},{0x12,0x6B},{0x13,0x6A},{0x16,0x77},{0x18,0x75},
    {0x1B,0x72},{0x1E,0x7F},{0x22,0x7B},{0x24,0x79},{0x28,0x05},{0x29,0x04},
    {0x2E,0x0F},{0x30,0x0D},{0x32,0x0B},{0x34,0x09},{0x3B,0x12},{0x40,0x1D},
    {0x44,0x19},{0x47,0x26},{0x48,0x25},{0x4A,0x23},{0x50,0x2D},{0x51,0x2C},
    {0x56,0x37},{0x57,0x36},{0x5A,0x33},{0x5B,0x32},{0x60,0x3D},{0x65,0x38},
    {0x66,0xC7},{0x68,0xC5},{0x6A,0xC3},{0x6B,0xC2},{0x70,0xCD},{0x72,0xCB},
    {0x74,0xC9},{0x7F,0xDE},{0x80,0xDD},{0x81,0xDC},{0x86,0xE7},{0x98,0xF5},
    {0x9A,0xF3},{0x9B,0xF2},{0x9C,0xF1},{0x9E,0xFF},{0xA0,0xFD},{0xA4,0xF9},
    {0xA6,0x87},{0xA7,0x86},{0xAC,0x81},{0xB0,0x8D},{0xBB,0x92},{0xC0,0x9D},
    {0xC2,0x9B},{0xC8,0xA5},{0xCE,0xAF},{0xD0,0xAD},{0xDA,0xB3},{0xE8,0x45},
    {0xED,0x40},{0xF0,0x4D},{0xF5,0x48}
};

static DWORD busReplyFor(BYTE param, BYTE *out)
{
    DWORD i;
    for (i = 0; i < sizeof(reply_bus_template); i++) out[i] = reply_bus_template[i];
    out[5] = (BYTE)(param ^ 0xC9);
    for (i = 0; i < sizeof(g_busTail) / 2; i++) {
        if (g_busTail[i][0] == param) { out[12] = g_busTail[i][1]; return 13; }
    }
    /* No recorded trailing byte for this address. Say so rather than invent one. */
    shimLog("   no recorded trailing byte for parameter 0x%02X - reply is incomplete", param);
    out[12] = 0;
    return 13;
}
static const BYTE reply_nothing[] = { 0x77, 0x07, 0x77, 0x07, 0x77, 0x07, 0x70 };

static void queueReply(const BYTE *data, DWORD len, const char *what)
{
    DWORD i;
    if (len > sizeof(g_rx)) len = sizeof(g_rx);
    for (i = 0; i < len; i++) g_rx[i] = data[i];
    g_rxLen = len;
    g_rxPos = 0;
    shimLog("   queued %s (%u byte(s))", what, len);
}

static void loadCandidate(void)
{
    DWORD i;

    if (g_rxLen > 0) {
        shimLog("ftd2xx-rx.hex has %u byte(s), so it wins over the built-in answer", g_rxLen);
        return;
    }
    for (i = 0; i < sizeof(g_announce); i++) g_rx[i] = g_announce[i];
    g_rxLen = sizeof(g_announce);
    g_rxPos = 0;
    g_key = g_announce[0];
    shimLog("SIGN-ON: the real cable's 27-byte announcement, identity \"V144Bn9\", key 0x%02X",
            g_key);
}

/*
 * Re-arms the announcement when DTR is released, and puts the key back with it.
 *
 * The software purges before pulsing DTR, so an announcement queued at load time is thrown away;
 * the cable's arrives *after* the pulse. Re-arming here models that. The key reset belongs here
 * too, because FUN_006ce388 rewrites it from the announcement it has just read.
 */
static void rearmCandidate(void)
{
    DWORD i;
    for (i = 0; i < sizeof(g_announce); i++) g_rx[i] = g_announce[i];
    g_rxLen = sizeof(g_announce);
    g_rxPos = 0;
    g_key = g_announce[0];
    resetFrame();
    shimLog("   re-armed the announcement, key back to 0x%02X", g_key);
}

/*
 * Accumulates outgoing bytes into frames, logs each in plaintext, and queues the cable's answer.
 *
 * **The software writes one byte per `FT_Write` call.** `FUN_006ccdd4` hands bytes to
 * `FUN_006ca098` singly, so a call is not a frame. The first version of this treated each call as
 * one and reported "the key has slipped" seventy-two times in a row while a perfectly good
 * thirty-six byte frame went past unrecognised. Bytes are therefore descrambled as they arrive -
 * the key advances per byte either way - and held until the frame's own length byte says it is
 * complete.
 *
 * A frame is `[length][command hi][command lo][parameter][payload...][additive checksum]`, with the
 * length byte counting everything except itself and the checksum, so the total is `plain[0] + 2`.
 */
static BYTE g_frame[256];
static DWORD g_frameLen = 0;
static DWORD g_frameWant = 0;
static BYTE g_frameKey = 0;

static void resetFrame(void)
{
    g_frameLen = 0;
    g_frameWant = 0;
}

static void dispatchFrame(void)
{
    DWORD i, sum = 0;
    unsigned cmd;

    for (i = 0; i + 1 < g_frameLen; i++) sum = (sum + g_frame[i]) & 0xFF;

    logBytes("   FRAME", g_frame, g_frameLen);
    if (sum != g_frame[g_frameLen - 1]) {
        shimLog("   checksum wrong (got %02X, frame says %02X) at key %02X - the key has slipped",
                sum, g_frame[g_frameLen - 1], g_frameKey);
        return;
    }

    cmd = ((unsigned)g_frame[1] << 8) | g_frame[2];
    shimLog("   COMMAND 0x%04X  parameter 0x%02X  payload %u byte(s)  [key %02X]",
            cmd, g_frame[3], g_frameLen - 5, g_frameKey);
    if (g_frameLen > 5) logBytes("   payload", g_frame + 4, g_frameLen - 5);

    if (cmd == 0xA77A) {
        shimLog("   this is the SIGN-ON response to the cable's challenge");
        queueReply(reply_signon, sizeof(reply_signon), "the cable's recorded answer [MEASURED]");
    } else if (cmd == 0x41AA) {
        queueReply(reply_ident, sizeof(reply_ident), "the cable's recorded answer [MEASURED]");
    } else if (cmd == 0x83F0) {
        BYTE r[13];
        DWORD n = busReplyFor(g_frame[3], r);
        queueReply(r, n, "the cable's recorded answer for this address [MEASURED]");
    } else {
        shimLog("   >>> UNKNOWN COMMAND 0x%04X parameter 0x%02X - nobody has asked the real",
                cmd, g_frame[3]);
        shimLog("   >>> cable this. Try it on the car; until then the answer below is made up.");
        queueReply(reply_nothing, sizeof(reply_nothing), "the 77 07 non-event [SUBSTITUTED]");
    }
}

static void handleFrame(const BYTE *wire, DWORD count)
{
    DWORD i;

    for (i = 0; i < count; i++) {
        BYTE p = (BYTE)(wire[i] ^ g_key);
        if (g_frameLen == 0) g_frameKey = g_key;
        g_key = (BYTE)(g_key + 0x4B);

        if (g_frameLen >= sizeof(g_frame)) {
            shimLog("   frame buffer full without a complete frame - resetting");
            resetFrame();
            continue;
        }
        g_frame[g_frameLen++] = p;

        if (g_frameLen == 1) {
            g_frameWant = (DWORD)p + 2;
            if (g_frameWant < 5 || g_frameWant > sizeof(g_frame)) {
                shimLog("   first byte %02X gives an impossible length %u - key out of step",
                        p, g_frameWant);
                resetFrame();
            }
            continue;
        }
        if (g_frameLen == g_frameWant) {
            dispatchFrame();
            resetFrame();
        }
    }
}


/* ------------------------------------------------------------------ memory dump */

/*
 * Writes the executable's own unpacked image out of its own address space.
 *
 * This is the thing the project set out to do and then abandoned. findings.md records the reason:
 * "Static decompilation of this binary is not viable. There is no code to decompile until the
 * protector unpacks itself in memory, which would require running it under a debugger and defeating
 * its anti-analysis measures." That was true of *static* analysis, and it stopped being the whole
 * picture the moment this shim started running - because the shim is a DLL inside the process, and
 * by the time the software asks for a device the protector has already finished unpacking.
 *
 * So there is nothing to defeat. We do not attach a debugger, do not single-step, do not break on
 * anything. We wait until the program is running its own real code and then copy it out from the
 * inside, which no anti-debugging measure is looking for.
 *
 * What gets written: every committed, readable region of the main module's image, each preceded by
 * a 16-byte header giving its address and length, so the host can reassemble or search it. Guard
 * pages and no-access regions are skipped rather than touched, since reading one would raise an
 * exception inside somebody else's process.
 */
static void dumpOwnImage(void)
{
    static BOOL done = FALSE;
    CHAR path[MAX_PATH];
    HANDLE out;
    MEMORY_BASIC_INFORMATION mbi;
    BYTE *addr;
    BYTE *base;
    IMAGE_DOS_HEADER *dos;
    IMAGE_NT_HEADERS *nt;
    DWORD imageSize, written, regions = 0, total = 0;

    if (done) return;
    done = TRUE;

    base = (BYTE *)GetModuleHandleA(NULL);
    if (!base) return;
    dos = (IMAGE_DOS_HEADER *)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
    nt = (IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return;
    imageSize = nt->OptionalHeader.SizeOfImage;

    wsprintfA(path, "%s\\unpacked.bin", g_dir);
    out = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, NULL,
                      CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (out == INVALID_HANDLE_VALUE) {
        shimLog("could not create %s", path);
        return;
    }

    shimLog("dumping the unpacked image: base %p, SizeOfImage %u", base, imageSize);

    addr = base;
    while (addr < base + imageSize) {
        if (!VirtualQuery(addr, &mbi, sizeof(mbi))) break;
        if (mbi.State == MEM_COMMIT &&
            !(mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD))) {
            DWORD hdr[4];
            hdr[0] = 0x504D5544;                 /* "DUMP" */
            hdr[1] = (DWORD)(ULONG_PTR)mbi.BaseAddress;
            hdr[2] = (DWORD)mbi.RegionSize;
            hdr[3] = mbi.Protect;
            WriteFile(out, hdr, sizeof(hdr), &written, NULL);
            WriteFile(out, mbi.BaseAddress, (DWORD)mbi.RegionSize, &written, NULL);
            regions++;
            total += (DWORD)mbi.RegionSize;
        }
        addr = (BYTE *)mbi.BaseAddress + mbi.RegionSize;
    }

    CloseHandle(out);
    shimLog("wrote %u region(s), %u byte(s) to unpacked.bin", regions, total);
}

/* ------------------------------------------------------------------ lifecycle */

/* Declared ahead of DllMain only so their addresses can be printed there. */
FT_STATUS WINAPI FT_Write(FT_HANDLE h, LPVOID buffer, DWORD count, LPDWORD written);
FT_STATUS WINAPI FT_Read(FT_HANDLE h, LPVOID buffer, DWORD count, LPDWORD returned);
FT_STATUS WINAPI FT_SetBaudRate(FT_HANDLE h, ULONG baud);
FT_STATUS WINAPI FT_Purge(FT_HANDLE h, ULONG mask);

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        CHAR path[MAX_PATH];
        DWORD n, i, cut = 0;

        InitializeCriticalSection(&g_lock);
        g_lockReady = TRUE;

        n = GetModuleFileNameA(inst, path, MAX_PATH);
        for (i = 0; i < n; i++) if (path[i] == '\\') cut = i;
        for (i = 0; i < cut; i++) g_dir[i] = path[i];
        g_dir[cut] = 0;

        /*
         * Prefer the VirtualBox shared folder when one is mounted. Reading the log then costs a
         * file read on the host instead of a screenshot of Notepad inside the guest, which is the
         * difference between examining a session in seconds and in minutes.
         */
        if (GetFileAttributesA("\\\\vboxsvr\\xfer") != INVALID_FILE_ATTRIBUTES)
            wsprintfA(g_logPath, "\\\\vboxsvr\\xfer\\ftd2xx-shim.log");
        else
            wsprintfA(g_logPath, "%s\\ftd2xx-shim.log", g_dir);
        wsprintfA(g_rxPath, "%s\\ftd2xx-rx.hex", g_dir);
        wsprintfA(g_statePath, "%s\\ftd2xx-state.txt", g_dir);

        logRaw("\r\n", 2);
        shimLog("================ shim loaded ================");
        shimLog("directory: %s", g_dir);
        refreshRx();
        loadCandidate();

        /*
         * Report where our own exports live, so the dump can be searched for them.
         *
         * The protector destroyed the import table, and the unpacked image has no recognisable
         * IAT - hunting for one by looking for clusters of out-of-image pointers finds only text
         * and code that happens to fall in range. But the executable must hold our addresses
         * somewhere in order to call us, so printing them turns that search into an exact lookup:
         * find the stored pointer, and the instruction that reads it is the call site. From a call
         * site the routine that builds the transmitted bytes is a short walk back.
         */
        shimLog("export addresses for dump lookup:");
        shimLog("   FT_Write        %p", (void *)&FT_Write);
        shimLog("   FT_Read         %p", (void *)&FT_Read);
        shimLog("   FT_SetBaudRate  %p", (void *)&FT_SetBaudRate);
        shimLog("   FT_Purge        %p", (void *)&FT_Purge);
        shimLog("   shim base       %p", (void *)inst);

        DisableThreadLibraryCalls(inst);
    } else if (reason == DLL_PROCESS_DETACH && g_lockReady) {
        shimLog("================ shim unloaded ==============");
    }
    return TRUE;
}

/* ------------------------------------------------------------------ enumeration */

/*
 * FT_ListDevices is three different functions wearing one name, and the first version of this got
 * two of them wrong.
 *
 *   FT_LIST_NUMBER_ONLY  0x80000000  pArg1 is a DWORD* to receive the count
 *   FT_LIST_BY_INDEX     0x40000000  pArg1 is the index *by value*, pArg2 a char buffer
 *   FT_LIST_ALL          0x20000000  pArg1 is an array of char* to fill and NULL-terminate,
 *                                    pArg2 is a DWORD* to receive the count
 *
 * The old code treated everything that was not NUMBER_ONLY as BY_INDEX and wrote a string into
 * pArg2 - which, for the FT_LIST_ALL form that software of this vintage usually calls, means
 * scribbling a device name over the caller's count variable and never filling the array it
 * actually reads. "No adapter" is the polite outcome of that.
 */
FT_STATUS WINAPI FT_ListDevices(PVOID pArg1, PVOID pArg2, DWORD flags)
{
    const CHAR *name = (flags & 2) ? g_desc : g_serial;

    shimLog("FT_ListDevices(flags=0x%08X)%s%s%s", flags,
            (flags & 0x80000000) ? "  [number only]" : "",
            (flags & 0x40000000) ? "  [by index]" : "",
            (flags & 0x20000000) ? "  [all]" : "");

    if (flags & 0x80000000) {
        if (pArg1) *(DWORD *)pArg1 = 1;
        return FT_OK;
    }

    if (flags & 0x20000000) {
        CHAR **slots = (CHAR **)pArg1;
        if (slots) {
            slots[0] = (CHAR *)name;      /* static storage, so handing out a pointer is safe */
            slots[1] = NULL;
        }
        if (pArg2) *(DWORD *)pArg2 = 1;
        return FT_OK;
    }

    /* BY_INDEX, and the index arrives by value rather than through a pointer. */
    if ((DWORD_PTR)pArg1 != 0) return FT_DEVICE_NOT_FOUND;
    if (pArg2) {
        CHAR *dst = (CHAR *)pArg2;
        int i = 0;
        while (name[i]) { dst[i] = name[i]; i++; }
        dst[i] = 0;
    }
    return FT_OK;
}

FT_STATUS WINAPI FT_CreateDeviceInfoList(LPDWORD count)
{
    shimLog("FT_CreateDeviceInfoList -> 1");
    if (count) *count = 1;
    return FT_OK;
}

typedef struct {
    ULONG Flags;
    ULONG Type;
    ULONG ID;
    DWORD LocId;
    CHAR SerialNumber[16];
    CHAR Description[64];
    FT_HANDLE ftHandle;
} FT_DEVICE_LIST_INFO_NODE;

static void fillNode(FT_DEVICE_LIST_INFO_NODE *n)
{
    int i;
    n->Flags = 0;
    n->Type = 5;                      /* FT_DEVICE_232R */
    n->ID = (0x0333u << 16) | 0x0137u;
    n->LocId = 0x101;
    for (i = 0; g_serial[i]; i++) n->SerialNumber[i] = g_serial[i];
    n->SerialNumber[i] = 0;
    for (i = 0; g_desc[i]; i++) n->Description[i] = g_desc[i];
    n->Description[i] = 0;
    n->ftHandle = NULL;
}

FT_STATUS WINAPI FT_GetDeviceInfoList(FT_DEVICE_LIST_INFO_NODE *dest, LPDWORD count)
{
    shimLog("FT_GetDeviceInfoList");
    if (count) *count = 1;
    if (dest) fillNode(dest);
    return FT_OK;
}

FT_STATUS WINAPI FT_GetDeviceInfoDetail(DWORD index, LPDWORD flags, LPDWORD type, LPDWORD id,
                                        LPDWORD locId, PCHAR serial, PCHAR desc, FT_HANDLE *h)
{
    FT_DEVICE_LIST_INFO_NODE n;
    int i;
    shimLog("FT_GetDeviceInfoDetail(index=%u)", index);
    if (index != 0) return FT_DEVICE_NOT_FOUND;
    fillNode(&n);
    if (flags) *flags = n.Flags;
    if (type) *type = n.Type;
    if (id) *id = n.ID;
    if (locId) *locId = n.LocId;
    if (serial) for (i = 0; (serial[i] = n.SerialNumber[i]) != 0; i++) {}
    if (desc) for (i = 0; (desc[i] = n.Description[i]) != 0; i++) {}
    if (h) *h = NULL;
    return FT_OK;
}

FT_STATUS WINAPI FT_GetDeviceInfo(FT_HANDLE h, LPDWORD type, LPDWORD id,
                                  PCHAR serial, PCHAR desc, PVOID dummy)
{
    int i;
    (void)h; (void)dummy;
    shimLog("FT_GetDeviceInfo");
    if (type) *type = 5;
    if (id) *id = (0x0333u << 16) | 0x0137u;
    if (serial) for (i = 0; (serial[i] = g_serial[i]) != 0; i++) {}
    if (desc) for (i = 0; (desc[i] = g_desc[i]) != 0; i++) {}
    return FT_OK;
}

/* ------------------------------------------------------------------ open / close */

FT_STATUS WINAPI FT_Open(int device, FT_HANDLE *handle)
{
    shimLog("FT_Open(device=%d)", device);
    dumpOwnImage();
    if (!handle) return FT_INVALID_HANDLE;
    *handle = SHIM_HANDLE;
    refreshRx();
    return FT_OK;
}

FT_STATUS WINAPI FT_OpenEx(PVOID arg1, DWORD flags, FT_HANDLE *handle)
{
    /* flags: 1 = by serial, 2 = by description, 4 = by location */
    if (flags & 3) shimLog("FT_OpenEx(flags=0x%X, \"%s\")", flags, (CHAR *)arg1);
    else shimLog("FT_OpenEx(flags=0x%X)", flags);
    dumpOwnImage();
    if (!handle) return FT_INVALID_HANDLE;
    *handle = SHIM_HANDLE;
    refreshRx();
    return FT_OK;
}

FT_STATUS WINAPI FT_Close(FT_HANDLE h)
{
    (void)h;
    flushEmptyReads();
    /*
     * The headline measurement. A wrong announcement is rejected after the software has read a
     * single byte; a right one makes it ask for more. So the consumed count, printed once per
     * close, is what separates a hit from a miss without anyone reading hex by eye.
     */
    shimLog("FT_Close   -- the software consumed %u of %u queued byte(s)%s",
            g_rxPos, g_rxLen,
            (g_rxLen > 1 && g_rxPos > 1) ? "   <<<<<< MORE THAN ONE - look here" : "");
    return FT_OK;
}

/* ------------------------------------------------------------------ data */

FT_STATUS WINAPI FT_Write(FT_HANDLE h, LPVOID buffer, DWORD count, LPDWORD written)
{
    (void)h;
    flushEmptyReads();
    shimLog("FT_Write(%u byte(s))  [%u baud, %u%c%u]", count, g_baud, g_bits,
         g_parity == 0 ? 'N' : (g_parity == 1 ? 'O' : (g_parity == 2 ? 'E' : '?')),
         g_stop == 0 ? 1 : 2);
    if (buffer && count) {
        logBytes("TX", (const BYTE *)buffer, count);
        handleFrame((const BYTE *)buffer, count);
    }
    if (written) *written = count;
    return FT_OK;
}

FT_STATUS WINAPI FT_Read(FT_HANDLE h, LPVOID buffer, DWORD count, LPDWORD returned)
{
    DWORD give = 0;
    (void)h;
    if (!g_lockReady) return FT_IO_ERROR;
    EnterCriticalSection(&g_lock);
    refreshRx();
    give = g_rxLen - g_rxPos;
    if (give > count) give = count;
    if (give && buffer) {
        DWORD i;
        BYTE *out = (BYTE *)buffer;
        for (i = 0; i < give; i++) out[i] = g_rx[g_rxPos + i];
        g_rxPos += give;
    }
    LeaveCriticalSection(&g_lock);

    /*
     * The software polls one byte at a time while it waits, which in the first run produced
     * thousands of identical lines and buried everything else. Empty reads are counted and
     * summarised instead; anything that actually happens flushes the counter first, so the
     * interesting lines keep their place in the sequence.
     */
    if (give == 0) {
        g_emptyReads++;
        if (g_emptyReads == 1)
            shimLog("FT_Read(asked %u) -> 0   (polling; further empty reads are counted)", count);
        if (returned) *returned = 0;
        return FT_OK;
    }
    flushEmptyReads();
    shimLog("FT_Read(asked %u) -> %u", count, give);
    logBytes("RX", (const BYTE *)buffer, give);
    if (returned) *returned = give;
    return FT_OK;
}

FT_STATUS WINAPI FT_GetQueueStatus(FT_HANDLE h, LPDWORD rx)
{
    DWORD avail;
    (void)h;
    refreshRx();
    avail = g_rxLen - g_rxPos;
    if (rx) *rx = avail;
    /* Logged only when non-zero: the software polls this in a tight loop. */
    if (avail) shimLog("FT_GetQueueStatus -> %u", avail);
    return FT_OK;
}

FT_STATUS WINAPI FT_GetStatus(FT_HANDLE h, LPDWORD rx, LPDWORD tx, LPDWORD ev)
{
    (void)h;
    refreshRx();
    if (rx) *rx = g_rxLen - g_rxPos;
    if (tx) *tx = 0;
    if (ev) *ev = 0;
    return FT_OK;
}

/* ------------------------------------------------------------------ line settings */

FT_STATUS WINAPI FT_SetBaudRate(FT_HANDLE h, ULONG baud)
{
    (void)h;
    g_baud = baud;
    shimLog("FT_SetBaudRate(%u)", baud);
    return FT_OK;
}

FT_STATUS WINAPI FT_SetDivisor(FT_HANDLE h, USHORT divisor)
{
    (void)h;
    shimLog("FT_SetDivisor(0x%04X)", divisor);
    return FT_OK;
}

FT_STATUS WINAPI FT_SetDataCharacteristics(FT_HANDLE h, UCHAR bits, UCHAR stop, UCHAR parity)
{
    (void)h;
    g_bits = bits; g_stop = stop; g_parity = parity;
    shimLog("FT_SetDataCharacteristics(bits=%u stop=%u parity=%u)", bits, stop, parity);
    return FT_OK;
}

FT_STATUS WINAPI FT_SetFlowControl(FT_HANDLE h, USHORT flow, UCHAR xon, UCHAR xoff)
{
    (void)h;
    shimLog("FT_SetFlowControl(0x%04X, xon=0x%02X, xoff=0x%02X)", flow, xon, xoff);
    return FT_OK;
}

FT_STATUS WINAPI FT_SetTimeouts(FT_HANDLE h, ULONG rd, ULONG wr)
{
    (void)h;
    shimLog("FT_SetTimeouts(read=%u write=%u)", rd, wr);
    return FT_OK;
}

FT_STATUS WINAPI FT_SetLatencyTimer(FT_HANDLE h, UCHAR ms)
{
    (void)h;
    shimLog("FT_SetLatencyTimer(%u)", ms);
    return FT_OK;
}

FT_STATUS WINAPI FT_GetLatencyTimer(FT_HANDLE h, PUCHAR ms)
{
    (void)h;
    if (ms) *ms = 16;
    return FT_OK;
}

FT_STATUS WINAPI FT_SetUSBParameters(FT_HANDLE h, ULONG in, ULONG out)
{
    (void)h;
    shimLog("FT_SetUSBParameters(in=%u out=%u)", in, out);
    return FT_OK;
}

FT_STATUS WINAPI FT_SetChars(FT_HANDLE h, UCHAR ev, UCHAR evEn, UCHAR er, UCHAR erEn)
{
    (void)h;
    shimLog("FT_SetChars(event=0x%02X/%u error=0x%02X/%u)", ev, evEn, er, erEn);
    return FT_OK;
}

FT_STATUS WINAPI FT_Purge(FT_HANDLE h, ULONG mask)
{
    (void)h;
    shimLog("FT_Purge(mask=%u)%s", mask, mask & 1 ? "  [RX]" : "");
    if (mask & 1) {
        /* Purging RX discards anything queued, exactly as the chip would. */
        if (g_lockReady) EnterCriticalSection(&g_lock);
        g_rxPos = g_rxLen;
        if (g_lockReady) LeaveCriticalSection(&g_lock);
    }
    return FT_OK;
}

FT_STATUS WINAPI FT_ResetDevice(FT_HANDLE h)
{
    (void)h;
    shimLog("FT_ResetDevice");
    return FT_OK;
}

FT_STATUS WINAPI FT_ResetPort(FT_HANDLE h) { (void)h; shimLog("FT_ResetPort"); return FT_OK; }
FT_STATUS WINAPI FT_CyclePort(FT_HANDLE h) { (void)h; shimLog("FT_CyclePort"); return FT_OK; }

/* ------------------------------------------------------------------ handshake lines */

FT_STATUS WINAPI FT_SetDtr(FT_HANDLE h) { (void)h; shimLog("FT_SetDtr      <-- DTR asserted"); return FT_OK; }
FT_STATUS WINAPI FT_ClrDtr(FT_HANDLE h)
{
    (void)h;
    shimLog("FT_ClrDtr      <-- DTR released");
    rearmCandidate();
    return FT_OK;
}
FT_STATUS WINAPI FT_SetRts(FT_HANDLE h) { (void)h; shimLog("FT_SetRts"); return FT_OK; }
FT_STATUS WINAPI FT_ClrRts(FT_HANDLE h) { (void)h; shimLog("FT_ClrRts"); return FT_OK; }

FT_STATUS WINAPI FT_GetModemStatus(FT_HANDLE h, LPDWORD status)
{
    (void)h;
    /* CTS and DSR asserted, no line errors - the quiet, healthy answer. */
    if (status) *status = 0x0030;
    return FT_OK;
}

FT_STATUS WINAPI FT_SetBreakOn(FT_HANDLE h) { (void)h; shimLog("FT_SetBreakOn"); return FT_OK; }
FT_STATUS WINAPI FT_SetBreakOff(FT_HANDLE h) { (void)h; shimLog("FT_SetBreakOff"); return FT_OK; }

/* ------------------------------------------------------------------ bit mode */

FT_STATUS WINAPI FT_SetBitMode(FT_HANDLE h, UCHAR mask, UCHAR mode)
{
    (void)h;
    shimLog("FT_SetBitMode(mask=0x%02X mode=0x%02X)%s", mask, mode,
         mode == 0x20 ? "  [CBUS bitbang]" : (mode == 0x01 ? "  [async bitbang]" :
         (mode == 0x04 ? "  [sync bitbang]" : (mode == 0x00 ? "  [reset]" : ""))));
    return FT_OK;
}

FT_STATUS WINAPI FT_GetBitMode(FT_HANDLE h, PUCHAR mode)
{
    (void)h;
    if (mode) *mode = 0xFF;
    return FT_OK;
}

/* ------------------------------------------------------------------ EEPROM */

FT_STATUS WINAPI FT_ReadEE(FT_HANDLE h, DWORD offset, LPWORD value)
{
    (void)h;
    if (offset >= 64) return FT_IO_ERROR;
    if (value) *value = g_eeprom[offset];
    shimLog("FT_ReadEE(0x%02X) -> 0x%04X", offset, g_eeprom[offset]);
    return FT_OK;
}

FT_STATUS WINAPI FT_WriteEE(FT_HANDLE h, DWORD offset, WORD value)
{
    (void)h;
    shimLog("FT_WriteEE(0x%02X, 0x%04X)  -- IGNORED, the shim never writes", offset, value);
    return FT_OK;
}

FT_STATUS WINAPI FT_EraseEE(FT_HANDLE h)
{
    (void)h;
    shimLog("FT_EraseEE  -- IGNORED");
    return FT_OK;
}

/*
 * FT_PROGRAM_DATA as the 3.01 generation of the library laid it out. Only the fields the start-up
 * is likely to read are filled; the layout matters more than the contents, because the caller
 * supplies the structure and reads fixed offsets out of it.
 */
typedef struct {
    DWORD Signature1;
    DWORD Signature2;
    DWORD Version;
    WORD VendorId;
    WORD ProductId;
    char *Manufacturer;
    char *ManufacturerId;
    char *Description;
    char *SerialNumber;
    WORD MaxPower;
    WORD PnP;
    WORD SelfPowered;
    WORD RemoteWakeup;
    /* the remainder is per-device configuration this shim does not need to invent */
} FT_PROGRAM_DATA_HEAD;

static void copyStr(char *dst, const CHAR *src)
{
    int i = 0;
    if (!dst) return;
    while (src[i]) { dst[i] = src[i]; i++; }
    dst[i] = 0;
}

FT_STATUS WINAPI FT_EE_Read(FT_HANDLE h, PVOID data)
{
    FT_PROGRAM_DATA_HEAD *p = (FT_PROGRAM_DATA_HEAD *)data;
    (void)h;
    shimLog("FT_EE_Read");
    if (!p) return FT_IO_ERROR;
    p->VendorId = 0x0333;
    p->ProductId = 0x0137;
    p->MaxPower = 90;
    p->PnP = 1;
    p->SelfPowered = 0;
    p->RemoteWakeup = 1;
    copyStr(p->Manufacturer, g_manuf);
    copyStr(p->ManufacturerId, "PA");
    copyStr(p->Description, g_desc);
    copyStr(p->SerialNumber, g_serial);
    return FT_OK;
}

FT_STATUS WINAPI FT_EE_ReadEx(FT_HANDLE h, PVOID data, char *m, char *mid, char *d, char *s)
{
    (void)h;
    shimLog("FT_EE_ReadEx");
    copyStr(m, g_manuf);
    copyStr(mid, "PA");
    copyStr(d, g_desc);
    copyStr(s, g_serial);
    return FT_EE_Read(h, data);
}

FT_STATUS WINAPI FT_EE_Program(FT_HANDLE h, PVOID data)
{
    (void)h; (void)data;
    shimLog("FT_EE_Program  -- IGNORED, the shim never writes");
    return FT_OK;
}

FT_STATUS WINAPI FT_EE_ProgramEx(FT_HANDLE h, PVOID d, char *a, char *b, char *c, char *e)
{
    (void)h; (void)d; (void)a; (void)b; (void)c; (void)e;
    shimLog("FT_EE_ProgramEx  -- IGNORED");
    return FT_OK;
}

FT_STATUS WINAPI FT_EE_UASize(FT_HANDLE h, LPDWORD size)
{
    (void)h;
    if (size) *size = 0;
    shimLog("FT_EE_UASize -> 0");
    return FT_OK;
}

FT_STATUS WINAPI FT_EE_UARead(FT_HANDLE h, PUCHAR data, DWORD len, LPDWORD read)
{
    (void)h; (void)data; (void)len;
    if (read) *read = 0;
    shimLog("FT_EE_UARead -> 0");
    return FT_OK;
}

FT_STATUS WINAPI FT_EE_UAWrite(FT_HANDLE h, PUCHAR data, DWORD len)
{
    (void)h; (void)data; (void)len;
    shimLog("FT_EE_UAWrite  -- IGNORED");
    return FT_OK;
}

/* ------------------------------------------------------------------ events, misc */

FT_STATUS WINAPI FT_SetEventNotification(FT_HANDLE h, DWORD mask, PVOID param)
{
    (void)h; (void)param;
    shimLog("FT_SetEventNotification(mask=0x%08X)", mask);
    return FT_OK;
}

FT_STATUS WINAPI FT_GetEventStatus(FT_HANDLE h, LPDWORD ev)
{
    (void)h;
    if (ev) *ev = 0;
    return FT_OK;
}

FT_STATUS WINAPI FT_SetWaitMask(FT_HANDLE h, DWORD mask) { (void)h; (void)mask; return FT_OK; }
FT_STATUS WINAPI FT_WaitOnMask(FT_HANDLE h, LPDWORD mask) { (void)h; if (mask) *mask = 0; return FT_OK; }
FT_STATUS WINAPI FT_StopInTask(FT_HANDLE h) { (void)h; shimLog("FT_StopInTask"); return FT_OK; }
FT_STATUS WINAPI FT_RestartInTask(FT_HANDLE h) { (void)h; shimLog("FT_RestartInTask"); return FT_OK; }
FT_STATUS WINAPI FT_SetResetPipeRetryCount(FT_HANDLE h, DWORD n) { (void)h; (void)n; return FT_OK; }
FT_STATUS WINAPI FT_SetDeadmanTimeout(FT_HANDLE h, ULONG t) { (void)h; (void)t; return FT_OK; }

FT_STATUS WINAPI FT_IoCtl(FT_HANDLE h, DWORD code, PVOID a, DWORD b, PVOID c, DWORD d, LPDWORD e, PVOID f)
{
    (void)h; (void)a; (void)b; (void)c; (void)d; (void)f;
    shimLog("FT_IoCtl(code=0x%08X)", code);
    if (e) *e = 0;
    return FT_OK;
}

/* ------------------------------------------------------------------ W32 layer */

HANDLE WINAPI FT_W32_CreateFile(LPCSTR name, DWORD access, DWORD share, LPVOID sec,
                                DWORD create, DWORD flags, HANDLE tmpl)
{
    (void)name; (void)access; (void)share; (void)sec; (void)create; (void)flags; (void)tmpl;
    shimLog("FT_W32_CreateFile");
    refreshRx();
    return (HANDLE)SHIM_HANDLE;
}

BOOL WINAPI FT_W32_CloseHandle(HANDLE h) { (void)h; shimLog("FT_W32_CloseHandle"); return TRUE; }

BOOL WINAPI FT_W32_ReadFile(HANDLE h, LPVOID buf, DWORD count, LPDWORD read, LPVOID ov)
{
    DWORD got = 0;
    (void)h; (void)ov;
    FT_Read(SHIM_HANDLE, buf, count, &got);
    if (read) *read = got;
    return TRUE;
}

BOOL WINAPI FT_W32_WriteFile(HANDLE h, LPVOID buf, DWORD count, LPDWORD written, LPVOID ov)
{
    DWORD done = 0;
    (void)h; (void)ov;
    FT_Write(SHIM_HANDLE, buf, count, &done);
    if (written) *written = done;
    return TRUE;
}

BOOL WINAPI FT_W32_PurgeComm(HANDLE h, DWORD flags) { (void)h; FT_Purge(SHIM_HANDLE, flags); return TRUE; }
BOOL WINAPI FT_W32_SetCommBreak(HANDLE h) { (void)h; shimLog("FT_W32_SetCommBreak"); return TRUE; }
BOOL WINAPI FT_W32_ClearCommBreak(HANDLE h) { (void)h; shimLog("FT_W32_ClearCommBreak"); return TRUE; }
BOOL WINAPI FT_W32_SetCommMask(HANDLE h, DWORD m) { (void)h; (void)m; return TRUE; }
BOOL WINAPI FT_W32_WaitCommEvent(HANDLE h, LPDWORD ev, LPVOID ov) { (void)h; (void)ov; if (ev) *ev = 0; return TRUE; }
BOOL WINAPI FT_W32_CancelIo(HANDLE h) { (void)h; return TRUE; }
BOOL WINAPI FT_W32_GetOverlappedResult(HANDLE h, LPVOID ov, LPDWORD n, BOOL wait)
{ (void)h; (void)ov; (void)wait; if (n) *n = 0; return TRUE; }
DWORD WINAPI FT_W32_GetLastError(HANDLE h) { (void)h; return 0; }

BOOL WINAPI FT_W32_ClearCommError(HANDLE h, LPDWORD errs, LPVOID stat)
{
    (void)h;
    refreshRx();
    if (errs) *errs = 0;
    if (stat) {
        /* COMSTAT: cbInQue at offset 4, cbOutQue at 8 on this layout. */
        DWORD *s = (DWORD *)stat;
        s[0] = 0;
        s[1] = g_rxLen - g_rxPos;
        s[2] = 0;
    }
    return TRUE;
}

BOOL WINAPI FT_W32_EscapeCommFunction(HANDLE h, DWORD func)
{
    (void)h;
    /* SETDTR 5, CLRDTR 6, SETRTS 3, CLRRTS 4 */
    shimLog("FT_W32_EscapeCommFunction(%u)%s", func,
         func == 5 ? "  <-- DTR asserted" : (func == 6 ? "  <-- DTR released" : ""));
    if (func == 6) rearmCandidate();
    return TRUE;
}

BOOL WINAPI FT_W32_GetCommModemStatus(HANDLE h, LPDWORD st) { (void)h; if (st) *st = 0x0030; return TRUE; }
BOOL WINAPI FT_W32_GetCommState(HANDLE h, LPVOID dcb) { (void)h; (void)dcb; return TRUE; }

BOOL WINAPI FT_W32_SetCommState(HANDLE h, LPVOID dcb)
{
    (void)h;
    if (dcb) {
        DWORD *d = (DWORD *)dcb;
        g_baud = d[1];               /* DCB: DCBlength, BaudRate, ... */
        shimLog("FT_W32_SetCommState(baud=%u)", g_baud);
    }
    return TRUE;
}

BOOL WINAPI FT_W32_GetCommTimeouts(HANDLE h, LPVOID t) { (void)h; (void)t; return TRUE; }
BOOL WINAPI FT_W32_SetCommTimeouts(HANDLE h, LPVOID t) { (void)h; (void)t; return TRUE; }
BOOL WINAPI FT_W32_SetupComm(HANDLE h, DWORD in, DWORD out) { (void)h; (void)in; (void)out; return TRUE; }
