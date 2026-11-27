---
sidebar_position: 7
description: Reach Zluggish from other devices, with a Cloudflare Tunnel setup for the web app and the game.
---

# Remote access

Zluggish listens on `127.0.0.1` by default, so only the server itself can connect. That is enough when Zwift runs on the same computer. To let other devices on your local network connect, set `network.host` to `0.0.0.0` so Zluggish listens on all IPv4 interfaces, set `server.advertisedIp` to the server's LAN IP, and open the [ports](../reference/ports.md). The web app still uses plain HTTP, so a browser on another device warns that the connection is not secure.

To give the web app HTTPS or reach Zluggish from outside your local network, you have several options:

- A reverse proxy with a TLS certificate gives the web app HTTPS. Set `network.web.publicUrl` to the proxy's address. This is only safe if the proxy stays on your local network, since Zluggish is not designed for the public internet.
- With a VPN such as WireGuard or Tailscale, remote devices reach the server over the VPN as if they were on the local network.
- With Cloudflare Tunnel, the web app gets an HTTPS address behind Cloudflare Access, and you and your friends can run Zwift from any location. Cloudflare Access also lets each household's launcher show only its own riders.

The rest of this guide sets up Cloudflare Tunnel in stages. You only need the stages for what you want to do, and only the most complete setup uses all of them:

| Stage                                                           | What you get                                                                      | What you set up                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1. [Web app](#web-app)                                          | The web app at an HTTPS address, behind Cloudflare Access                         | A published application on the tunnel. Riders install nothing.        |
| 2. [Zwift game](#zwift-game)                                    | Riders in other households can ride on your server                                | Cloudflare One Client on each remote Zwift device, with split tunnels |
| 3. [Gateway DNS](#redirect-the-zwift-names-with-gateway-dns)    | Cloudflare points the Zwift names at your server, so desktops skip the hosts file | A DNS firewall policy. Android needs it.                              |
| 4. [Household riders](#show-each-household-only-its-own-riders) | Each household's launcher lists only its own riders                               | Cloudflare sign-in in the launcher and rider groups in Zluggish       |

Every stage needs a [Cloudflare Zero Trust organization](https://developers.cloudflare.com/cloudflare-one/setup/) and a tunnel. The free Cloudflare plan covers all four stages, but Cloudflare asks for a credit card when you create the account. In the Cloudflare dashboard, go to **Networking → Tunnels → Create a tunnel**. Follow the [tunnel setup instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) to run `cloudflared` where it can reach Zluggish. One tunnel serves all stages.

## Stage 1: Web app {#web-app}

Riders open the web app in a browser from anywhere. They pass Cloudflare Access and then sign in to Zluggish. Nothing needs to be installed on their devices.

1. Choose a hostname on a domain you manage in Cloudflare, such as `zluggish.example.com`.
2. Open **Zero Trust → Access controls → Applications**. Select **Create new application → Self-hosted and private → Add public hostname**. Enter the hostname, leave the path blank, and add an **Allow** policy for the people who need access. Save the [Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).
3. Open **Networking → Tunnels**, select your tunnel, and go to **Routes → Add route → Published application**. Enter the same hostname.

   For **Service URL**, enter the address where `cloudflared` reaches the web listener over HTTP. If `cloudflared` runs on the server, use `http://127.0.0.1:8080`. If it runs on another machine, use the server's private IP and make sure the web listener accepts connections on that IP. See [Web app listener](../reference/configuration.md#web-app-listener) for the bind address and port settings.

4. In the route's **Additional application settings**, turn on **Protect with Access**. Select your Zero Trust team and the Access application's audience tag, then save the route. See [Cloudflare's tunnel setup for Access](https://developers.cloudflare.com/reference-architecture/design-guides/identity-gated-edge/#remotely-managed-tunnel).
5. In `zluggish.config.ts`, set `network.web.publicUrl` to the HTTPS origin, such as `https://zluggish.example.com`. Restart Zluggish.

Open the HTTPS address, pass Cloudflare Access, and sign in with your Zluggish account. Cloudflare handles HTTPS for the browser. Zluggish uses `publicUrl` to check the origin of requests that change data and to mark its session cookies secure.

If you only need the web app from outside your home, you can stop here.

## Stage 2: Zwift game {#zwift-game}

Riders in another household run Zwift against your server. Each remote Zwift device runs Cloudflare One Client, and its split tunnel sends traffic for the server's private IP through your tunnel.

With the default ports, the remote device must reach the server's private IP on HTTPS 443, HTTP 80, TCP 3025 and UDP 3024. See [Ports](../reference/ports.md) for what each port does.

1. In `zluggish.config.ts`, set `server.advertisedIp` to the server's private IP, for example `192.168.1.100`. The game listeners must accept connections on that IP. On a native installation that still listens on loopback, set `network.host` to the private IP. If your stage 1 route uses the loopback URL, also set `network.web.host` to `'127.0.0.1'` so the web listener stays on loopback. Restart Zluggish.
2. In the Cloudflare dashboard, open **Networking → Routes → Create route**, then choose **Tunnel CIDR**. Select your tunnel, enter the server's address as a single-host route such as `192.168.1.100/32`, and save. See [Add a CIDR route](https://developers.cloudflare.com/cloudflare-one/networks/routes/add-routes/#add-a-cidr-route).
3. Open **Zero Trust → Traffic policies → Traffic settings**. Under **Proxy and inspection settings**, turn on **Allow Secure Web Gateway to proxy traffic** and select both **TCP** and **UDP**. See [Gateway proxy settings](https://developers.cloudflare.com/cloudflare-one/traffic-controls/proxy/#turn-on-the-gateway-proxy).
4. Open **Zero Trust → Team & Resources → Devices → Device profiles → General profiles**. Select **Configure** for the profile your Zwift devices use, then **Split Tunnels → Manage**.
   - In **Include** mode, add the server's route and keep the [required Zero Trust destinations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-cidr/#3-route-private-network-ips-through-the-cloudflare-one-client) in the list.
   - In **Exclude** mode, adjust any excluded range that contains the server's IP so only the other addresses in that range stay excluded. See [Split Tunnels](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/route-traffic/split-tunnels/).

5. In **Zero Trust → Team & Resources → Devices → Device profiles → Management**, open **Device enrollment → Device enrollment permissions → Manage** and allow the riders who can enroll devices. See [Device enrollment permissions](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/device-enrollment/).
6. [Install and enroll Cloudflare One Client](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/manual-deployment/) on each remote Zwift device. Use **Traffic and DNS** mode.
7. Follow the setup guide for [Windows](clients/windows.md), [macOS](clients/macos.md), [Linux](clients/linux.md) or [Android](clients/android.md) to install the certificate or patched app. On desktop, put the server's private IP in the hosts file, or use [Gateway DNS](#redirect-the-zwift-names-with-gateway-dns) instead. Android needs Gateway DNS.

Give the server's network and each remote network different IP ranges, or the routes will conflict. If the web listener is also reachable over the private route, open `http://<server-ip>:8080/health` on the remote device to check that it reaches Zluggish. To check the game connection, launch a ride.

## Stage 3: Redirect the Zwift names with Gateway DNS {#redirect-the-zwift-names-with-gateway-dns}

This stage builds on stage 2. A [Gateway DNS override](https://developers.cloudflare.com/cloudflare-one/traffic-controls/dns-policies/#override) makes the original Zwift hostnames resolve to your server's private IP on enrolled devices. If you use it on desktop, turn off **Patch hosts file** when you download the setup script, and remove any earlier Zluggish entries from the hosts file so the DNS answer takes effect. See [DNS settings](clients/dns-settings.md#setup-script-windows-macos-and-linux).

1. In the Cloudflare dashboard, go to **Zero Trust → Traffic policies → Firewall policies**. On the **DNS** tab, select **Add a policy**. See [Set up DNS filtering](https://developers.cloudflare.com/cloudflare-one/traffic-controls/get-started/dns/#3-create-your-first-dns-policy).
2. Use the **Host** selector with the **in** operator. Add `us-or-rly101.zwift.com`, `secure.zwift.com`, `cdn.zwift.com` and `launcher.zwift.com`.

   ![Gateway DNS policy matching the four Zwift hostnames](../../media/screenshots/cloudflare-gateway-dns-hosts.png)

3. Select **Override**, enter the server's private IP in **Override destination**, and select **Create policy**.

   ![Gateway DNS Override action pointing to the example server IP 192.168.1.100](../../media/screenshots/cloudflare-gateway-dns-override.png)

## Stage 4: Show each household only its own riders {#show-each-household-only-its-own-riders}

Cloudflare Access can decide which riders appear in the desktop launcher. This last stage is optional, even when several households share the server. Without it, the launcher lists every enabled rider. Zluggish matches the Cloudflare email against the rider groups you configure and against any rider whose login name is that email. The launcher remembers the Cloudflare identity for 30 days. Riders still enter their Zluggish password unless the launcher has saved it. Riders with a [one-time password](../usage/web-app.md#administrator-pages) must first choose their own password in the web app.

It builds on stage 1, because the launcher must reach the [Access-protected web app](#web-app). The launcher must also reach the game server, through [stage 2](#zwift-game) or the local network. A device on the server's local network can use the Cloudflare sign-in without enrolling in Cloudflare One Client. The Android apps and the web app keep their usual Zluggish sign-in.

### Turn on the sign-in

1. In **Zero Trust → Access controls → Applications**, select **Edit** for the web app's Access application. Under **Additional settings**, copy the [Application Audience (AUD) Tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag).
2. Find the [team domain](https://developers.cloudflare.com/cloudflare-one/faq/getting-started-faq/#what-is-a-team-domainteam-name) under **Zero Trust → Settings**, for example `example.cloudflareaccess.com`.
3. Set both values in `zluggish.config.ts`. Keep the web listener enabled and use the web app's HTTPS origin for `publicUrl`. The Access application for that hostname must cover `/launcher/link`.

   ```ts
   network: {
     web: {
       publicUrl: 'https://zluggish.example.com',
       cloudflareAccess: { teamDomain: 'example.cloudflareaccess.com', audience: '<AUD tag>' },
     },
   },
   ```

4. Restart Zluggish.

### Choose who sees which riders

As a Zluggish administrator, open **Manage → Launcher access**. This page appears once launcher sign-in is enabled.

- Make a group for each household and add its Cloudflare email addresses and riders. Every email in a group can see the group's enabled riders. An email or rider can be in more than one group.
- **Riders no launcher can pick** lists enabled riders that have no group and no email login. Add them to a group.
- **Waiting for a group** lists emails that signed in but have no riders to pick. You can add them to a group from there.

The launcher picks up changes the next time it loads the rider list.

### What riders see

- The launcher offers **Sign in with Cloudflare** when it needs a Cloudflare identity, including after the 30-day sign-in expires.
- After sign-in, the launcher shows the available riders and the signed-in email address.
- If the email has no riders, the launcher asks the rider to contact an administrator. Once the administrator adds access, the rider selects **Check again**. **Sign in with Cloudflare** starts the sign-in over.

### Skip the login prompt on your Cloudflare One Client

On devices enrolled in stage 2, riders with an active Cloudflare One Client session can skip the Access login prompt, because Cloudflare uses the identity enrolled on the device. This [client session feature](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/client-sessions/#configure-client-sessions-in-access) is in beta. It supports Access applications that use **Allow** or **Block** policies and have **Binding Cookie** disabled.

1. In **Zero Trust → Access controls → Access settings**, enable **Authenticate with Cloudflare One Client**, choose a **Session duration** of up to 90 days, and save.
2. In **Zero Trust → Access controls → Applications**, edit the web app's Access application and enable **Authenticate with Cloudflare One Client** there too. The **Apply to all Access applications** option in Access settings turns this on for every application, so use it only if you want that.
3. Make sure the web app hostname, team domain and identity provider are reachable through Cloudflare One Client. In **Include** mode, add those destinations in the device profile's **Split Tunnels → Manage** list.

The device signs in as the person who enrolled it. Cloudflare may prompt again when the client session expires. Devices without an enrolled client get the usual Access login.
