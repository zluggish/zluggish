---
sidebar_position: 7
description: Reach the Zluggish web app and game server remotely through Cloudflare.
---

# Remote access

By default, Zluggish listens to `127.0.0.1` which means it only accepts request from the local machine. This is fine if you are running Zwift on the same machine, but you will get an insecure http connection warning when browsing to the webapp.

You can set up remote access to Zluggish in several ways, including a simple reverse proxy (only secure if restricted to your local network), Wireguard Tailscale or Cloudflare Tunnel. This guide will show how to set up Cloudflare.

With this setup, you will get a TLS certificate for the webapp and you and your friends can run the Zwift app from any location.

| Access                    | What to set up                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Web app](#web-app)       | Publish an HTTPS hostname with Cloudflare Access. The tunnel forwards requests to the Zluggish HTTP listener.                      |
| [Zwift game](#zwift-game) | Route the server's private IP over the tunnel. Install the Cloudflare One Client on each Zwift device for game HTTPS, TCP and UDP. |

Both need a Cloudflare account and a [tunnel with `cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) running where it can reach Zluggish. You can use the same tunnel for both.

## Web app

1. Choose a hostname on a domain you manage in Cloudflare, such as `zluggish.example.com`.
2. [Create a self-hosted Access app](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) for that hostname. Add an Allow policy for the people who need access.
3. Add a **Published application** route to your tunnel. Use service URL `http://localhost:8080` if `cloudflared` runs on the server, or `http://<server-ip>:8080` if it runs elsewhere. Enable **Protect with Access**.
4. In `zluggish.config.ts`, set `network.web.publicUrl` to the full HTTPS origin, such as `https://zluggish.example.com`.
5. Restart Zluggish, then open the HTTPS address and sign in.

Cloudflare provides HTTPS to the browser. Zluggish uses the configured origin to validate changes and mark session cookies secure.

## Zwift game

Zwift connects using the original Zwift hostnames and needs TCP port 3025 and UDP port 3024 for riding, in addition to HTTPS 443 and HTTP 80. Use a private route for these [game ports](../reference/ports.md).

1. Add a **CIDR** route to the tunnel for the server's private IP, for example `192.168.1.10/32`.
2. In the Cloudflare One device profile, [configure Split Tunnels](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/route-traffic/split-tunnels/) so the server IP goes through the tunnel. In **Include** mode, add the route. In **Exclude** mode, adjust any excluded range that contains the server IP.
3. Enable [TCP and UDP proxying](https://developers.cloudflare.com/cloudflare-one/traffic-controls/proxy/).
4. Set `server.advertisedIp` to that private IP in `zluggish.config.ts` and restart Zluggish.
5. [Enroll the Cloudflare One Client](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/warp/) on each Zwift device. Connect it in **Traffic and DNS** mode.
6. Follow the setup guide for [Windows](clients/windows.md), [macOS](clients/macos.md), [Linux](clients/linux.md) or [Android](clients/android.md) to install the certificate or patched app. Use the private IP in the desktop hosts file or set a Gateway DNS override below.

If port 8080 is reachable over the private route and the web listener is enabled, open `http://<server-ip>:8080/health` on the Zwift device to check the route. Use different IP ranges at home and at the remote location to avoid routing conflicts.

### Redirect the Zwift names with Gateway DNS

Use a [Gateway DNS policy](https://developers.cloudflare.com/cloudflare-one/traffic-controls/dns-policies/#override) to resolve the Zwift hostnames to the private IP.

1. Use the **Host** selector and **in** operator to match the hostnames for your app.
   - For the game, match `secure.zwift.com`, `us-or-rly101.zwift.com`, `cdn.zwift.com` and `launcher.zwift.com`.
   - For Companion alone, match `secure.zwift.com` and `us-or-rly101.zwift.com`.

2. Set the action to **Override** and enter the server's private IP in **Override Hostname**.
3. Scope the policy to your riders, for example with **User Email**. It redirects official Zwift traffic for devices that match it.
4. If you use a desktop setup script, turn off **Patch hosts file** in **Advanced settings** and remove any old Zluggish entries from the hosts file.

On Android, turn off Virtual Hosts before connecting Cloudflare One Client. If Android **Private DNS** bypasses Gateway, turn it off. Companion uses the public CDN for images, so leave `cdn.zwift.com` out of Companion-only policies.
