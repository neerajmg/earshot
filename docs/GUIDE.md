# earshot user guide

earshot sends a file from one device to the one next to it, as sound. The
sending device plays the file through its speaker; the receiving device
listens through its microphone, rebuilds the bytes, checks them, and offers
the file to save. There is nothing to install and no network involved: both
devices open the same web page. This guide is for the person doing the
transfer. The [README](../README.md) is for whoever wants to know how it
works inside.

Every screenshot here, and every table under a heading marked *generated*, is
produced from the page by `npm run guide`. `npm test` fails when the page has
changed and this guide has not, so what you see here is what you get.

## What to expect

- It is slow. Sound through air is a narrow channel: a few hundred bytes a
  second, so a note or a key is seconds, a document a minute or two, a photo
  a quarter of an hour. The table in
  [How long it takes](#how-long-it-takes-generated) has the numbers.
- It is audible. The sender plays a short upward sweep, then about two
  seconds of dense, hiss-like tone, over and over until you stop it.
- It is a broadcast. Anyone within earshot who has this page open receives
  what you send. Set a passphrase when that matters; see
  [Passphrase](#passphrase).
- Both devices should sit still, close together, in a quiet room. A phone
  waved about shifts the pitch of what it hears, and the receiver has to
  chase it.

## Open the page

Open **https://neerajmg.github.io/earshot/** on both devices. The published
page is served over HTTPS, which the browser requires before it will hand a
page the microphone; open it over plain HTTP from somewhere else and
pressing **Listen** says `The microphone needs a secure page. Open
https://neerajmg.github.io/earshot/ on both devices rather than a local
copy.`

To run it from a copy of the repository instead, in the folder that holds
`index.html`:

    python3 -m http.server 8000

and open http://localhost:8000 (`localhost` counts as secure). Serve it, do
not double-click `index.html`: the receiver runs in a worker and an audio
worklet, and browsers will not load those from a file on disk.

It was built and tested in Chrome. On a phone you can add it to the home
screen and it opens full screen, like an app.

![The page after loading](screenshots/product/page.png)

**Receive** is the first card, **Send** the second; on a phone they stack in
that order. Each device uses one of the two, and the order on screen is the
order to work in: the device that is receiving presses **Listen** first,
then the other one picks a file and presses **Start sending**.

One device cannot do both. Press **Start sending** on a device that is
listening and it refuses; press **Listen** on one that is sending and it
refuses too. A device that decoded its own speaker would look like a
finished transfer and prove nothing.

**Advanced**, under both cards, opens the engine line, a spectrogram and a
log, which you only need when something is wrong.

## Receive

Start the receiver first. Listening costs nothing, and the sender's first
seconds are wasted if nobody is listening yet. Starting late is not fatal,
though: every frame announces the file, so a receiver that joins part way
still gets it.

1. Press **Listen** and allow the microphone when the browser asks. The
   button turns into **Stop listening** and the status line says
   `Listening… start the sender on the other device.`

   ![Listening](screenshots/product/listening.png)

   If the microphone will not open, the page says which of three things went
   wrong rather than repeating the browser's error: the microphone is
   blocked for this page, no microphone was found, or another app or tab is
   holding it. Each one names the fix and asks you to press **Listen** again.

2. Keep the page in front and the device still. If you switch away, the
   browser may starve the audio; the log under **Advanced** says
   `page hidden - audio may be throttled` when that happens.
3. While it waits, the status line tells you which of three things is true,
   and they call for different fixes:

   - `Listening — silence for 12 s. Start the sender on the other device and
     turn its volume up.` Nothing is reaching the microphone at all. Either
     the sender has not started, or its sound is going somewhere else, or
     something is over the microphone.
   - `Listening — sound is reaching the microphone, but nothing from earshot
     yet.` The room is being heard; none of it is earshot. Usually the other
     device has not pressed **Start sending** yet.
   - `Listening — the sender is audible but too rough to read. Move the
     devices closer, turn the volume up, quieten the room.` Frames are
     arriving and failing their checks. This is the one that closer, stiller
     and quieter actually fixes.

4. As frames arrive, a progress bar appears and the status says
   `Receiving readings.csv — 21 %`. When the sender set a passphrase the
   name travels inside the encryption, so it reads
   `Receiving an encrypted file — 21 %` until you unlock it.

   ![A transfer part way through](screenshots/product/receiving.png)

   If the sound stops part way, the line says so instead of freezing:
   `61 % of the way there, but nothing heard for 14 s — is the sender still
   playing?`

5. When the file is complete, the status says `The whole file arrived.`, the
   result box names the file and its real size, and listening stops by
   itself.
6. Press **Save file**. On a phone that offers a share sheet, that is what
   opens; otherwise the file downloads and the line underneath says where it
   went.

   ![Received and ready to save](screenshots/product/received.png)

A file can arrive complete and still fail its checksum. That does not end
the transfer. The receiver throws away what it rebuilt, says `That arrived
damaged — still listening. Leave the sender running and the missing pieces
will come.`, and keeps the microphone open. Leave the sender playing; the
next pass usually repairs it.

If the sender set a passphrase, the result box asks for it before
**Save file** appears; see [Passphrase](#passphrase).

## Send

1. **Choose a file**, or drag one onto the box on a device with a mouse.
   Up to 2 MB; anything bigger is refused with `Over 2 MB — sound is too
   slow for a file that big. Send something smaller, or zip it first.`, and
   nothing stays selected. The line under the box says how big
   the file is and roughly how long it will take, and when compression helps
   it quotes the smaller size that actually goes on the air:
   `13.8 kB — about 15 s of sound (3.2 kB on air after compression).`
   No file handy? **Use the sample file** loads a short built-in text so
   you can try a transfer in under ten seconds.

   ![A file chosen](screenshots/product/send-picked.png)

   ![The sample file, ready to send](screenshots/product/sample-file.png)

   ![Too big](screenshots/product/too-big.png)

2. Optionally type a passphrase under **Passphrase (optional)**. It
   encrypts the file and its name; typed messages go out plain. See
   [Passphrase](#passphrase).
3. Wait until the other device says it is listening, then press
   **Start sending**. The status says `Getting the file ready…` for a moment
   (compression, and encryption if you set a passphrase), then counts up:
   `Sending — 29 %, about 10 s left. Keep both devices still.`
4. Volume somewhere in the middle. A speaker driven into distortion is
   worse than a quieter one, and the two devices should be close anyway.
5. **The sender does not stop by itself.** It keeps playing frames, because
   it cannot hear whether the receiver is done and extra frames only help a
   receiver that missed some. Past the estimate the bar stops measuring and
   the status reads `Still sending — keep going until the other device says
   it has the file, then press Stop sending.` When the other device says
   `The whole file arrived.`, press **Stop sending**; the status then says
   `Stopped after 41 s of sound.`

   ![Sending](screenshots/product/sending.png)

6. To send a message instead of a file, type it under **or type a message**
   and press **Send message**. It travels as a small file called
   `message.txt` and the receiver shows it on screen as soon as it lands,
   with the same **Save file** button underneath. A message always goes out
   in the clear, so anyone in earshot can read one; put anything private in
   a file instead. With something in the passphrase box **Send message**
   refuses rather than quietly dropping the passphrase.

   ![A message being sent](screenshots/product/send-text.png)

   ![The message, shown on the receiver as it lands](screenshots/product/received-text.png)

**Speed and limits**, folded at the foot of the Send card, is a table of
file size against how long that size takes. It is computed from the frame
format rather than typed in: 768 bytes of your file per 2.07-second frame,
plus two spare frames, so a 1 kB message is a few seconds and the 2 MB
maximum is over an hour. Those rows are for a file that does not compress
and a transfer that loses nothing. A noisy room needs a few extra frames,
and text compresses before it goes out, which is why a text file often
finishes early.

![Speed and limits, opened](screenshots/product/speed-and-limits.png)

## Passphrase

Sound is a broadcast: any device in the room with this page open and
**Listen** pressed receives the file. If that matters, type a passphrase
under **Passphrase (optional)** before you press **Start sending**. The file
is encrypted with it before it goes on the air, and so is the file's name,
which is why the other device says `Receiving an encrypted file` until it is
unlocked. Nothing of the passphrase itself is transmitted; tell the other
person the passphrase some other way.

The size still travels in the clear. Every frame has to say how big the
transfer is, so that a device joining part way through can size what it is
rebuilding. Anyone listening can tell that something of about that many
bytes went past, but not what it was or what it was called.

The passphrase is used exactly as typed, on both sides. It is never
trimmed, because trimming would change the secret, so a leading or trailing
space counts. The page says so under the field rather than removing it:
`This passphrase ends with a space. It is used exactly as typed, so the
other device needs that space too.` A passphrase of nothing but spaces is
refused, with a note saying to clear the field to send without one.

A typed message is the exception: it is always sent unencrypted. Pressing
**Send message** while the passphrase box has anything in it is refused with
`A message is sent without a passphrase. Clear the passphrase field to send
this message, or save the text as a file and use Start sending.` Do one or
the other; the page will not choose for you.

On the receiving side the transfer looks the same until it completes. Then
the result box says `Encrypted file` and shows a
**Passphrase from the sender** field with an **Unlock** button. Type the
passphrase and press **Unlock**; the box changes to the file's real name and
size, the line under it says `Ready to save.`, and **Save file** appears. A
wrong passphrase is reported, not silently decrypted into garbage, and you
can try again.

![Received, waiting for the passphrase](screenshots/product/received-locked.png)

![A wrong passphrase](screenshots/product/wrong-passphrase.png)

## How long it takes (generated)

<!-- gen:timing -->
| file | frames | sound |
|---|---:|---:|
| a note, a key, a config (2.0 kB) | 5 | 0:10 |
| a small document (30.0 kB) | 42 | 1:27 |
| a photo (300.0 kB) | 402 | 13:50 |
| the 2 MB ceiling (2.00 MB) | 2733 | 94:05 |

One frame is 2.07 s of sound and carries 768 bytes of the file, 372 bytes per second. The table is for a file that does not compress and a transfer that loses nothing; text usually compresses two to three times, and every lost frame adds one more.
<!-- /gen:timing -->

The estimate the page shows when you choose a file does not come from this
table. It compresses the file exactly as the transfer will, and encrypts it
too if you have typed a passphrase, so the seconds quoted beside a text file
are usually well under what the table suggests. A noisy room makes anything
take longer. What helps: the devices close together, still, and the room quiet.
What does not help: turning the volume all the way up.

## On a phone

![The page on a phone](screenshots/product/phone.png)

The cards stack, Receive on top. There is no drag hint on the file box,
because there is nothing to drag with; **Choose a file** opens the picker.
**Save file** opens the share sheet where there is one, so
the file can go straight to another app. The page asks the system to keep
the screen on while it is sending or listening; if the screen locks anyway,
listening stops, so keep the phone awake.

## Under Advanced

![Advanced, during a transfer](screenshots/product/advanced.png)

Open **Advanced** when you want to see what the engine is doing.

- The first line says the audio rate and, once listening, what the browser
  did with the microphone: `mic AEC false NS false AGC false` is what you
  want. The page asks for echo cancelling, noise suppression and automatic
  gain to be off, because all three eat the signal; a browser that keeps one
  on says `true` there.
- The spectrogram shows what the microphone hears, so it stays blank on the
  sending side. It scrolls right to left and covers 0 to 8 kHz, low at the
  bottom. The two white lines mark the edges of the signal, 1.5 and
  7.5 kHz: a good transfer is a bright band between them, in two-second
  blocks with short gaps, and not much below the lower line. A blank
  spectrogram while the other device is playing means the microphone is not
  hearing it.
- The log. `listening (worklet)` when the microphone opens; then one line
  per frame, `frame decoded — 3 droplets`, where a droplet is one of the
  three pieces of the file inside a frame. The counts are that frame's, not
  a running total, so a healthy transfer is the same line over and over.
  A frame that lost pieces adds them: `frame decoded — 1 droplet,
  2 rejected`, and one that lost all of them reads `frame decoded but
  nothing usable in it — 3 droplets rejected`, in red. `audio gap` means the
  browser dropped some audio, which happens when the page is in the
  background. On the sending side, `sending readings.csv: 13.8 kB -> 3.2 kB
  on air, encrypted` records what went out.

![Advanced, while sending](screenshots/product/advanced-sending.png)

The links at the bottom of **Advanced** lead to [the lab page](LAB.md), the
original modem with all its instruments, and the device checks: a page that
measures whether this device can run audio at 48 kHz, whether its microphone
hears the whole band, the room's echo, the speaker's loudness headroom, and
a forty-minute soak of the receive pipeline.

## When it does not work

![Receiving through noise](screenshots/product/receiving-noisy.png)

![The log during a noisy transfer](screenshots/product/advanced-noisy.png)

| What you see | What it means | What to do |
|---|---|---|
| `The microphone needs a secure page.` | The page was opened over plain HTTP or from disk | Use the published page, or serve the folder and open http://localhost:8000 |
| `The microphone is blocked for this page.` | Permission was refused | Allow it from the padlock in the address bar, then press **Listen** again |
| `No microphone was found.` | The device has no input, or the wrong one is selected | Connect one, or choose one in the system sound settings |
| `Another app or tab is holding the microphone.` | Something else has it open, often a second tab of this page | Close it, then press **Listen** again |
| `Listening — silence for 12 s.` while the other device is playing | No sound at all is reaching the microphone | Open **Advanced**: a blank spectrogram means nothing arrives. Sender louder and closer, nothing covering the microphone, sender's sound not going to headphones or a Bluetooth speaker |
| `Listening — sound is reaching the microphone, but nothing from earshot yet.` | The room is heard, but none of it is a frame | Check the other device really is sending, and that you are not hearing something else |
| `Listening — the sender is audible but too rough to read.` | Frames arrive and fail | Closer, stiller, quieter; this is the case where that helps most |
| Progress bar appears, then stalls or creeps | Frames are being lost; `rejected` counts in the log climb | Keep the sender going; it is built to fill the gaps |
| `61 % of the way there, but nothing heard for 14 s` | The sender stopped, or moved out of range, part way | Start it again; the receiver keeps what it already has |
| `That arrived damaged — still listening.` | The whole file was rebuilt and failed its checksum | Nothing. Leave the sender running; the receiver stays open and the next pass usually repairs it |
| `audio gap` in the log, progress stalls | The page is in the background or the device is busy | Bring the page to the front and leave it there |
| `page hidden - audio may be throttled` | You switched tabs or apps | Same |
| `Still sending — keep going until the other device says it has the file` | The estimate has passed, which is normal in a noisy room | Wait for the receiver to say `The whole file arrived.`, then press **Stop sending** |
| `Wrong passphrase — check it and try again; passphrases are case-sensitive.` | What you typed is not what the sender typed | Type it again exactly. Spaces count; if what you typed starts or ends with one, the page says so |
| `Wrong passphrase` on a passphrase you are certain is right | The two devices typed the same letters as different bytes. An accent composed one way on one keyboard and another way on the other looks identical on screen and does not match | Retype it on both devices, or agree on one with no accents |
| `This device is listening, so it would hear its own speaker.` or `This device is sending, and it would only hear itself.` | One device tried to send and receive at once | Use two devices; one listens, the other sends |
| `A message is sent without a passphrase.` | **Send message** was pressed with something in the passphrase box | Clear the box, or save the text as a file and use **Start sending** |
| `Over 2 MB — sound is too slow for a file that big. Send something smaller, or zip it first.` | The file is over the limit | Send something smaller, or zip it first |
| `transfer not complete — wait until the whole file has arrived.` | **Unlock** was pressed before the transfer finished | Wait for `The whole file arrived.` |
| **Save file** on a phone downloads instead of sharing | The share sheet was dismissed, or this browser cannot share files | It is the same file; look in the browser's downloads |

When a transfer fails in a way this table does not cover, the lab page can
record what the microphone heard as a WAV file, which is the most useful
thing to attach to a bug report; see [LAB.md](LAB.md).

## Every control

Receive card, which comes first: **Listen**, which becomes **Stop listening**
while the microphone is open, the progress bar and status line, and the
result box with the file's name and size, the text itself when it is a short
text file, **Passphrase from the sender** and **Unlock** when the sender
encrypted, **Save file** when the file is ready, and a line saying what
happened to it.

Send card, top to bottom: **Choose a file** (or drag one onto the box),
**Use the sample file** under the size note, **Passphrase (optional)**,
**Start sending**, which becomes **Stop sending** while sending; then the
progress bar and the status line; then an **or type a message** divider, the
message box and **Send message**; and **Speed and limits** folded
underneath.

**Advanced** opens the engine line, the spectrogram, the log, and links to
the lab page and the device checks.

## Limits (generated)

<!-- gen:limits -->
- Files up to 2 MB (2,097,152 bytes). Bigger ones are refused before anything plays.
- File names travel as up to 64 bytes of UTF-8; a longer name is trimmed to fit, on a character boundary and keeping its extension. With a passphrase the name travels inside the ciphertext, under the same limit.
- Compression is gzip, used only when it saves at least 5 %; the log line under **Advanced** shows the size before and after.
- Passphrase: AES-256-GCM, key derived from the passphrase with PBKDF2-SHA-256 over 600,000 iterations, fresh salt and nonce per transfer. A wrong passphrase is detected, not silently decrypted to garbage.
- Audio runs at 48000 Hz. A device that cannot is resampled, and **Advanced** says so.
- The log under **Advanced** keeps the last 250 lines.
<!-- /gen:limits -->

## The numbers (generated)

How the sound is made, for the curious. The README's "How it works" is the
prose version.

<!-- gen:engine -->
- 1024-point FFT at 48000 Hz: subcarriers 46.875 Hz apart, bins 32 to 159 (1500 to 7453 Hz). 116 carry data as QPSK, 8 are pilots that track the two devices' clocks, 4 stay silent so the noise floor is measured every symbol.
- 37.5 symbols per second: 1024 samples plus a 256-sample cyclic prefix, so echoes up to 5.3 ms late do no harm.
- A frame: a 40 ms chirp (1500 to 5500 Hz) that the receiver finds with a matched filter, a 10 ms guard, one channel-estimation symbol, 2 signalling symbols that say what the frame is, 72 data symbols, and a 15 ms gap: 2.07 s.
- Coding: K=7 rate-1/2 convolutional, soft-decision Viterbi, each bit weighted by its subcarrier's SNR so a dead frequency counts as unknown rather than wrong. 1043 bytes come out of a frame: a 96-byte manifest (name, size, checksum, flags) and 3 droplets of 266 bytes.
- Fountain: the file is cut into 256-byte blocks and windows of 256 blocks (64 kB). Droplets are blocks, then random combinations of blocks; any enough of them rebuild a window, so a lost frame costs time, never a pass.
<!-- /gen:engine -->

## Keeping this guide current

`npm run guide product` runs `tools/make-guide.js` for this page. It prepares
a sample file (a 14 kB CSV of sensor readings, with a passphrase), opens the
page in headless Chrome, and takes the screenshots above from the live page:
the static states directly, and the receiving states by feeding the rendered
transfer to a fake microphone in real time, with a little white noise under it
so the spectrogram looks like a room. The noisy example is the same transfer
under enough noise that pieces of frames fail their checks. It then rewrites
the *generated* tables from the constants in the code and records which
versions of the page's source files it saw.

`npm test` includes a check that fails when any of those files has changed
since the last run, when a table is out of date, when a screenshot is missing
or unused, or when a button, label or disclosure on the page is not named in
this guide. Editing one of the files inside Claude Code triggers the same
check straight away, through the hook in `.claude/settings.json`.

The generator does not write sentences. After a change that a user would
notice, regenerate, then read the section it touches and fix the words.
