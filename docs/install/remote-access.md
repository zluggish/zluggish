---
sidebar_position: 7
description: Reach the Zluggish web app and game server remotely through Cloudflare.
---

# Remote access

Zluggish listens only on the server itself by default. To reach it remotely with Cloudflare, choose the setup you need:

| Access                    | What to set up                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [Web app](#web-app)       | Publish an HTTPS hostname protected by Cloudflare Access. Riders open it in a browser.                      |
| [Zwift game](#zwift-game) | Route the server's private IP through Cloudflare Tunnel. Each remote Zwift device runs Cloudflare One Client. |

Both setups require a [Cloudflare Zero Trust organization](https://developers.cloudflare.com/cloudflare-one/setup/). In the Cloudflare dashboard, go to **Networking → Tunnels → Create a tunnel**. Follow the [tunnel setup instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) to run `cloudflared` where it can reach Zluggish. You can use one tunnel for both setups.

## Web app

1. Choose a hostname on a domain you manage in Cloudflare, such as `zluggish.example.com`.
2. Open **Zero Trust → Access controls → Applications**. Select **Create new application → Self-hosted and private → Add public hostname**. Enter the hostname, leave the path blank, and add an **Allow** policy for the people who need access. Save the [Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).
3. Open **Networking → Tunnels**, select your tunnel, and go to **Routes → Add route → Published application**. Enter the same hostname.

   For **Service URL**, use the web listener's HTTP address as seen by `cloudflared`. Use `http://127.0.0.1:8080` if the connector can reach Zluggish over loopback. For a connector on another machine, use the server's private IP and make sure the web listener is reachable there. See [Web app listener](../reference/configuration.md#web-app-listener) for the bind address and port settings.

4. In the route's **Additional application settings**, turn on **Protect with Access**. Select your Zero Trust team and the Access application's audience tag, then save the route. See [Cloudflare's tunnel setup for Access](https://developers.cloudflare.com/reference-architecture/design-guides/identity-gated-edge/#remotely-managed-tunnel).
5. In `zluggish.config.ts`, set `network.web.publicUrl` to the HTTPS origin, such as `https://zluggish.example.com`. Restart Zluggish.

Open the HTTPS address. After passing Cloudflare Access, sign in with your Zluggish account. Cloudflare provides HTTPS to the browser. Zluggish uses `publicUrl` to check the origin of requests that change data and mark its session cookies secure.

## Zwift game

The remote device must reach the server's private IP on HTTPS 443, HTTP 80, TCP 3025 and UDP 3024 by default. See [Ports](../reference/ports.md) for what each port does.

1. In `zluggish.config.ts`, set `server.advertisedIp` to the server's private IP, for example `192.168.1.100`. Make sure the game listeners accept connections on that IP. For a native installation using the loopback default, set `network.host` to the private IP. To keep a same-host web route using the loopback URL above, set `network.web.host` to `'127.0.0.1'`. Restart Zluggish.
2. In the Cloudflare dashboard, open **Networking → Routes → Create route**, then choose **Tunnel CIDR**. Select your tunnel, enter the server's address as a single-host route such as `192.168.1.100/32`, and save. See [Add a CIDR route](https://developers.cloudflare.com/cloudflare-one/networks/routes/add-routes/#add-a-cidr-route).
3. Open **Zero Trust → Traffic policies → Traffic settings**. Under **Proxy and inspection settings**, turn on **Allow Secure Web Gateway to proxy traffic** and select both **TCP** and **UDP**. See [Gateway proxy settings](https://developers.cloudflare.com/cloudflare-one/traffic-controls/proxy/#turn-on-the-gateway-proxy).
4. Open **Zero Trust → Team & Resources → Devices → Device profiles → General profiles**. Select **Configure** for the profile your Zwift devices use, then **Split Tunnels → Manage**.

   - In **Include** mode, add the server's route and keep the [required Zero Trust destinations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-cidr/#3-route-private-network-ips-through-the-cloudflare-one-client) in the list.
   - In **Exclude** mode, adjust any excluded range that contains the server's IP so only the other addresses in that range stay excluded. See [Split Tunnels](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/route-traffic/split-tunnels/).

5. In **Zero Trust → Team & Resources → Devices → Device profiles → Management**, open **Device enrollment → Device enrollment permissions → Manage** and allow the riders who can enroll devices. See [Device enrollment permissions](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/device-enrollment/).
6. [Install and enroll Cloudflare One Client](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/manual-deployment/) on each remote Zwift device. Use **Traffic and DNS** mode.
7. Follow the setup guide for [Windows](clients/windows.md), [macOS](clients/macos.md), [Linux](clients/linux.md) or [Android](clients/android.md) to install the certificate or patched app. On desktop, you can use the server's private IP in the hosts file or use the Gateway DNS override below. On Android, use the Gateway DNS override with Cloudflare One Client.

Use different IP ranges at the server and remote locations to avoid routing conflicts. If the web listener is also reachable over the private route, open `http://<server-ip>:8080/health` on the remote device to check that it can reach Zluggish. Launching a ride checks the game connection.

### Redirect the Zwift names with Gateway DNS

A [Gateway DNS override](https://developers.cloudflare.com/cloudflare-one/traffic-controls/dns-policies/#override) makes the original Zwift hostnames resolve to your server's private IP on enrolled devices. On desktop, turn off **Patch hosts file** when downloading the setup script if you use Gateway DNS. Remove any previous Zluggish hosts-file entries so DNS takes effect. See [DNS settings](clients/dns-settings.md#setup-script-windows-macos-and-linux).

1. In the Cloudflare dashboard, go to **Zero Trust → Traffic policies → Firewall policies**. On the **DNS** tab, select **Add a policy**. See [Set up DNS filtering](https://developers.cloudflare.com/cloudflare-one/traffic-controls/get-started/dns/#3-create-your-first-dns-policy).
2. Use the **Host** selector with the **in** operator. Add `us-or-rly101.zwift.com`, `secure.zwift.com`, `cdn.zwift.com` and `launcher.zwift.com`.

   ![Gateway DNS policy matching the four Zwift hostnames](../../media/screenshots/cloudflare-gateway-dns-hosts.png)

3. Select **Override**, enter the server's private IP in **Override destination**, and select **Create policy**.

   ![Gateway DNS Override action pointing to the example server IP 192.168.1.100](../../media/screenshots/cloudflare-gateway-dns-override.png)

## Show each household only its own riders

You can use Cloudflare Access to control which riders appear in the desktop launcher. Zluggish matches the Cloudflare email to the rider groups you configure and to any rider whose login name is that email. The launcher remembers the Cloudflare identity for 30 days. Each rider still needs their Zluggish password unless the launcher remembers it. Riders with a [one-time password](../usage/web-app.md#administrator-pages) must first choose their own password in the web app.

The launcher must be able to reach both the [Access-protected web app](#web-app) and the game server. A device that already reaches the game server, for example over the local network, can use the Cloudflare sign-in without enrolling in Cloudflare One Client. Android apps and the web app use their usual Zluggish sign-in.

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

- Add the Cloudflare email addresses and riders for each household to a group. Everyone listed in a group's emails can see its enabled riders. An email or rider can belong to more than one group.
- **Riders no launcher can pick** lists enabled riders with neither a group nor an email login. Add these riders to a group.
- **Waiting for a group** lists emails that signed in and have no available riders. You can add them directly to a group.

Changes take effect the next time the launcher loads the rider list.

### What riders see

- The launcher offers **Sign in with Cloudflare** when it needs a Cloudflare identity, including after the 30-day sign-in expires.
- After sign-in, the launcher shows the available riders and the signed-in email address.
- If the email has no available riders, the launcher asks the rider to contact an administrator. The rider can select **Check again** after the administrator adds access, or select **Sign in with Cloudflare** to retry sign-in.

### Skip the login prompt on your Cloudflare One Client

Cloudflare can use the identity enrolled on the device so that riders with an active client session can skip the Access login prompt. This [client session feature](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/client-sessions/#configure-client-sessions-in-access) is in beta. It supports Access applications that use **Allow** or **Block** policies and have **Binding Cookie** disabled.

1. In **Zero Trust → Access controls → Access settings**, enable **Authenticate with Cloudflare One Client**, choose a **Session duration** of up to 90 days, and save.
2. In **Zero Trust → Access controls → Applications**, edit the web app's Access application and enable **Authenticate with Cloudflare One Client** there. Use **Apply to all Access applications** in Access settings only if you want this behavior across your applications by default.
3. Make sure the web app hostname, team domain and identity provider are reachable through Cloudflare One Client. In **Include** mode, add those destinations in the device profile's **Split Tunnels → Manage** list.

The device sends the identity of the person who enrolled it. Cloudflare may prompt again when the client session expires. Devices without an enrolled client use the usual Access login.
