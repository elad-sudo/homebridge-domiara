# homebridge-domiara

**Bring your TouchWand smart home to Apple Home + Siri — no controller upgrade.**

A [Homebridge](https://homebridge.io) plugin that logs into your existing **TouchWand**
controller on the local network and mirrors its devices and scenes into **Apple Home**, so you
can control them with the Home app, Siri, and Apple Home automations. It reuses Domiara's
field-tested LAN transport, so it speaks the exact protocol the Domiara iOS app uses.

> Independent, third-party project — **not** affiliated with, endorsed by, or sponsored by
> TouchWand. "TouchWand" is used only to state compatibility.

## What it exposes

| TouchWand device | Apple Home |
|---|---|
| Switch | Lightbulb (on/off) |
| Dimmer | Lightbulb (on/off + brightness) |
| Shutter / וילון | Window Covering (open/close + position) |
| Thermostat / AC | Thermostat (temperature + heat/cool/auto/off) |
| Motion sensor | Motion Sensor |
| Door/window sensor | Contact Sensor |
| Scene | Switch (tap to run) |

Battery-powered devices also report their battery level. Live changes stream in over the
controller's WebSocket, with a periodic refresh as a safety net.

## Requirements

- A **Homebridge** host (Raspberry Pi, a spare Mac/PC, a NAS, or [HOOBS](https://hoobs.org)) on
  the **same LAN** as your TouchWand controller.
- Your controller's **local IP** and your TouchWand **username + password**.

## Install

From the Homebridge UI, search for **Domiara** on the Plugins tab, or install manually:

```bash
# on the Homebridge host
npm install -g homebridge-domiara
```

### Building from this repo

This package lives in the Domiara monorepo and reuses `../src` transport code, so build the
self-contained bundle first:

```bash
cd bridge
npm install
npm run build     # bundles to dist/index.js
npm link          # (optional) to install into a local Homebridge
```

## Configure

Add the platform via the Homebridge UI (a config form is provided), or in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "Domiara",
      "name": "Domiara",
      "host": "192.168.1.50",
      "username": "you@example.com",
      "password": "••••••••",
      "includeScenes": true,
      "refreshSeconds": 60
    }
  ]
}
```

Restart Homebridge. Your devices appear in the Home app under the Homebridge bridge.

> **Tip — skip Apple's room-assignment wizard:** the Domiara iOS app (Settings → Apple Home rooms)
> imports your TouchWand rooms into Apple Home and files every bridged device into the right one,
> in one tap. Requires this plugin ≥ 0.3.0.

### Filtering devices

By default (since 0.2.0) the plugin **hides unconfigured devices** — endpoints that still carry
their auto-generated controller name, like `10.11 Switch` or `12.10 shutter`. Units nobody named
on the controller are usually unused, and 100+ of them clutter Apple Home badly.

- `"hideUnconfigured": false` — expose everything, like 0.1.x did.
- `"include": ["12.10 shutter"]` — expose specific devices even if they look unconfigured
  (exact name, case-insensitive, or device id).
- `"exclude": ["Boiler"]` — hide specific devices regardless of their name.

Hidden devices are removed from Apple Home automatically on the next sync.

## Security & privacy

- Talks **only** to your controller on your **local network** — no cloud, no third-party
  servers. Credentials stay in your Homebridge config on your host.
- The controller host is validated as private/link-local before any request (the same
  SSRF/spoofing guard the app uses); set `allowNonPrivateHost` only if you knowingly reach the
  controller via a trusted non-LAN address.
- Non-idempotent commands are issued exactly once (no blind retries).

## Roadmap

- Cloud fallback (control from a Homebridge host off the home LAN).
- Matter bridge, so the devices are usable by any Matter controller (Google/Amazon/SmartThings).

## License

MIT.
