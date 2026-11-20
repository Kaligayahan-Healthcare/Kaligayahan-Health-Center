# Launch testing (on the real computer and real phones)

## 1. Load test on the computer that will host the site

Start the server, then in a terminal in the project folder run:

```bat
"%LOCALAPPDATA%\KaligayahanHealthCenter\venv\Scripts\python.exe" backend\tools\load_test.py http://localhost:8123
```

- It only reads, so no records are created.
- It raises the number of simultaneous visitors from 5 to 200 and prints requests per second and waiting times.
- A health center with 100–200 patients a day rarely has more than 20–50 people on the site at once.
- **Good result:** at 50 visitors the median wait stays under 1 second.
- If it is much slower, check whether security software is scanning local connections. The development computer was limited to about 40 requests a second, even for an empty test server.

## 2. Real phones (after the site is online, see GOING-ONLINE.md)

Test with **mobile data, Wi-Fi off**. Use at least one older Android phone (the kind many residents use) and one iPhone.

| Check | Android | iPhone |
|---|---|---|
| Home page loads within about 5 seconds; the photo looks sharp | ☐ | ☐ |
| Text size button (Aa) makes text larger; high contrast works | ☐ | ☐ |
| Read aloud speaks in a clear voice | ☐ | ☐ |
| Get a queue number: every step, the keyboard does not hide the button, the number appears | ☐ | ☐ |
| Leave the ticket page open for 10 minutes: it updates when staff call the number | ☐ | ☐ |
| Close the browser, open the site again: "My ticket" still shows the number | ☐ | ☐ |
| "I am not a robot" check (if switched on) appears and works | ☐ | ☐ |
| Medicine request and email sign-up (confirm link in the email opens) | ☐ | ☐ |
| Doctors page: the duty calendar shows days off; tapping a day shows who is on duty | ☐ | ☐ |
| Turn on airplane mode for a minute: a "No connection" bar appears, then disappears when back online | ☐ | ☐ |
| Bottom tab bar is not covered by the phone's own buttons | ☐ | ☐ |

## 3. Staff on the clinic computers

| Check | Done |
|---|---|
| Each staff member signs in at `/staff` with their own account and changes the one-time password | ☐ |
| Two desks call patients from the same service at the same time: no patient is called twice | ☐ |
| Register a walk-in: the printed slip number matches the screen | ☐ |
| Add a doctor's day off: it shows on the public calendar | ☐ |
| Settings → Send a test email arrives | ☐ |
| Settings → Test the latest backup passes | ☐ |
| Leave the staff portal untouched for 30 minutes: it signs itself out | ☐ |

## 4. Screen reader (accessibility)

On Android, turn on **TalkBack**; on iPhone, **VoiceOver**. Check that the home page, the queue form and the ticket can be followed and completed by listening only.
