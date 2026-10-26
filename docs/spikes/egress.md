# Spike: egress allowlist (M3-T02)

Run on 2026-10-26 on Docker Desktop for Mac (Docker 29.2.1, linux/arm64), with tinyproxy from `alpine:3.22` and the Claude Code container from [claude-in-container](./claude-in-container.md). Every result below was observed. The Agent container is the `foreman-spike` image from the first spike, extended with `curl` and `python3` (`node:24-slim`, Claude Code 2.1.310, `git`, non-root user `agent`).

## Summary

**The design works with no fallback.** An `internal: true` network plus an allowlisting tinyproxy container leaves an Agent container able to reach Anthropic, npm and PyPI and nothing else. ADR 0003 needs no change beyond a confirming note.

| Check (from a container on the internal network) | Result |
|---|---|
| `claude -p` with `HTTPS_PROXY=http://proxy:8888` set (nothing else) | `OK`, `is_error: false` |
| `claude -p` with no proxy variable | no JSON result within `timeout 60`. This shows it did not work, not why. The refusal itself was shown with `curl` below |
| `npm view left-pad version` (npm `proxy` config) | `1.3.0` |
| `npm view is-odd version` (`HTTPS_PROXY` only) | `3.0.1` |
| `pip download six` in a venv (`HTTPS_PROXY` only) | `Successfully downloaded six` |
| `https://api.anthropic.com` | 404 (reached; the root path has no page) |
| `https://registry.npmjs.org/`, `https://pypi.org/simple/` | 200 |
| `https://files.pythonhosted.org/` | 404 (reached) |
| `https://github.com` | `CONNECT tunnel failed, response 403` |
| `git clone https://github.com/octocat/Hello-World` | `fatal: unable to access ...: CONNECT tunnel failed, response 403` |
| `https://raw.githubusercontent.com`, `https://example.com` | 403 |
| `https://api.anthropic.com.evil.com` (look-alike) | 403 |
| `https://1.1.1.1` through the proxy (IP literal) | 403 |
| `https://registry.npmjs.org:22` (allowed host, wrong port) | 403 |
| `http://github.com/` through the proxy (plain HTTP) | 403 |
| `http://registry.npmjs.org/` through the proxy (plain HTTP) | 301 (allowed; a redirect to HTTPS) |

## Bypass attempts

With no proxy variable, on the internal network only:

- `curl https://api.anthropic.com` gives `000` (no route).
- `curl https://1.1.1.1` gives `000`.
- `getent hosts github.com` gives no answer. Docker's DNS on an `internal` network resolves container names, not the internet, so there is no DNS tunnel to an outside resolver.
- `getent hosts proxy` gives `172.21.0.2`.
- `host.docker.internal` does not resolve. `192.168.65.254` (Docker Desktop's host address) refused a connection on port 80.

In these probes (HTTPS and HTTP to two targets, one DNS lookup, one host-address probe) nothing got out except through the proxy. Raw sockets, other ports and IPv6 were not probed, and `internal: true` is Docker's guarantee here, not something this spike proved in full.

## The design

Two networks and one proxy container:

```
docker network create --internal foreman-spike-internal   # Agent containers live here
docker network create foreman-spike-out                   # only the proxy touches this
docker run -d --name foreman-spike-proxy --network foreman-spike-out foreman-egress-proxy
docker network connect --alias proxy foreman-spike-internal foreman-spike-proxy
```

An Agent container then runs with `--network foreman-spike-internal -e HTTPS_PROXY=http://proxy:8888` (add `HTTP_PROXY`, and lower-case `http_proxy` for `curl`, which ignores the upper-case form).

The proxy image was built from this Dockerfile and these two files:

```
FROM alpine:3.22
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY allowlist /etc/tinyproxy/allowlist
EXPOSE 8888
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
```

`tinyproxy.conf`:

```
User tinyproxy
Group tinyproxy
Port 8888
Listen 0.0.0.0
Timeout 600
LogLevel Info
MaxClients 50
# Only the HTTPS port may be tunnelled; plain HTTP is filtered like everything else.
ConnectPort 443
FilterURLs Off
FilterExtended On
Filter "/etc/tinyproxy/allowlist"
FilterDefaultDeny Yes
```

`allowlist` (one anchored regex per host; a name that does not match is refused):

```
^api\.anthropic\.com$
^registry\.npmjs\.org$
^pypi\.org$
^files\.pythonhosted\.org$
```

Why tinyproxy and not squid: it is a single apk package with a short config, and it did everything needed. Its filter is a regex on the requested host, so anchor every entry (`^...$`). The look-alike `api.anthropic.com.evil.com` was refused because of the anchors.

## What this does not stop

- **An allowed host is still a way out.** Anything in the container can send data to `api.anthropic.com`, `registry.npmjs.org` or PyPI, for example with another account's credentials. It carries no GitHub credential, but the Run's token is in the environment (ADR 0003). The allowlist limits where data can go, not what an Agent can say to those three hosts.
- **Telemetry.** Without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, Claude Code tried to reach `http-intake.logs.us5.datadoghq.com`, which was refused with no effect on the Run. The proxy log showed one refusal for it (`Proxying refused on filtered domain "http-intake.logs.us5.data..."`, 15:15:31). A later Run with the variable set added no refusal, and it passed. Set it in M3-T04 to keep the logs clean.
- **The Verify Stage** (ADR 0008) will need the Target repo's own services and possibly more hosts. This spike covers the three registries only. Per-Agent extra hosts mean a second allowlist, which M3-T03 or M8-T01 can decide.
- **Only Docker Desktop for Mac was tested.** Linux hosts and other network drivers were not.

## Effects on the plan

- **M3-T03:** build the proxy image from the two files above, with the network definition as shown. `foreman images build` builds it. The base image needs `curl` only if you want its own checks to run inside it. `claude -p`, `npm` and `pip` all worked with only `HTTPS_PROXY` set; `curl` also needs lower-case `http_proxy` for plain HTTP.
- **M3-T04:** start Agent containers with `--network <internal>`, `HTTPS_PROXY`, `HTTP_PROXY`, `http_proxy` and `https_proxy` set to the proxy, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. The proxy must be running before any Run starts, and Docker network creation must be idempotent.
- **ADR 0003:** gains a confirming note. It does not need the "allow all egress" fallback from PLAN.md.
