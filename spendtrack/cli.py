"""spendtrack command line.

    spendtrack link     open the browser, connect an institution through Plaid Link
    spendtrack sync     pull new transactions for every linked institution
    spendtrack serve    run the dashboard
    spendtrack status   what is linked, and when it last synced
    spendtrack unlink   remove an institution from Plaid and from the database
    spendtrack reauth   re-authenticate an institution WITHOUT using a new Item
"""

import argparse
import sys
import webbrowser
from pathlib import Path

from dotenv import load_dotenv

from . import db

load_dotenv(Path.cwd() / ".env")
load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def cmd_sync(args) -> int:
    from . import plaid_sync

    conn = db.init()
    if not conn.execute("SELECT 1 FROM items LIMIT 1").fetchone():
        print("Nothing linked yet. Run: spendtrack link")
        return 1

    failed = False
    for result in plaid_sync.sync_all(conn, plaid_sync.client(), use_llm=not args.no_llm,
                                        full=args.full):
        if "error" in result:
            print(f"  {result['institution']}: ERROR {result['error']}")
            failed = True
        else:
            print(f"  {result['institution']}: +{result['added']} new, "
                  f"{result['modified']} updated, {result['removed']} removed")

    total = conn.execute("SELECT COUNT(*) n FROM transactions").fetchone()["n"]
    pending = conn.execute(
        "SELECT COUNT(*) n FROM transactions WHERE category_source = 'uncategorized'"
    ).fetchone()["n"]
    print(f"{total} transactions stored" + (f", {pending} uncategorised" if pending else ""))
    return 1 if failed else 0


def cmd_status(args) -> int:
    conn = db.init()
    items = conn.execute(
        "SELECT institution_name, status, last_synced_at, item_id FROM items"
    ).fetchall()
    if not items:
        print("Nothing linked yet. Run: spendtrack link")
        return 0
    for item in items:
        flag = "" if item["status"] == "ok" else f"  [{item['status']} - re-run link]"
        print(f"{item['institution_name'] or item['item_id']}"
              f"  last sync: {item['last_synced_at'] or 'never'}{flag}")
        for a in conn.execute(
            "SELECT name, mask, type, current_balance FROM accounts WHERE item_id = ?"
            " ORDER BY type, name", (item["item_id"],)
        ):
            bal = "-" if a["current_balance"] is None else f"${a['current_balance']:,.2f}"
            print(f"    {a['name']} ....{a['mask'] or '????'}  {a['type']:<10} {bal:>14}")
    return 0


def cmd_unlink(args) -> int:
    """Remove an institution. Deliberately explicit: this cannot be undone, and
    re-linking afterwards permanently consumes another of the 10 Trial Items."""
    from . import plaid_sync

    conn = db.init()
    matches = conn.execute(
        "SELECT item_id, institution_name FROM items WHERE institution_name LIKE ?",
        (f"%{args.institution}%",),
    ).fetchall()
    if not matches:
        print(f"No linked institution matching {args.institution!r}. Try: spendtrack status")
        return 1
    if len(matches) > 1:
        print("Matches more than one institution:")
        for m in matches:
            print(f"  {m['institution_name']}")
        return 1

    item = matches[0]
    counts = conn.execute("""
        SELECT (SELECT COUNT(*) FROM accounts WHERE item_id = ?) a,
               (SELECT COUNT(*) FROM transactions WHERE account_id IN
                    (SELECT account_id FROM accounts WHERE item_id = ?)) t
    """, (item["item_id"], item["item_id"])).fetchone()

    print(f"This removes {item['institution_name']}: "
          f"{counts['a']} accounts and {counts['t']} transactions.")
    print("Re-linking it afterwards uses another of your 10 Trial Items, permanently.")
    print("Your category rules and corrections are keyed on merchant and will survive.")
    if not args.yes and input("Type the institution name to confirm: ").strip().lower()             != (item["institution_name"] or "").lower():
        print("Cancelled.")
        return 1

    result = plaid_sync.remove_item(conn, plaid_sync.client(), item["item_id"])
    where = "Plaid and locally" if result["removed_at_plaid"] else "locally (already gone at Plaid)"
    print(f"Removed {result['institution']} from {where}: "
          f"{result['accounts']} accounts, {result['transactions']} transactions.")
    print("Now run: spendtrack link")
    return 0


def cmd_reauth(args) -> int:
    """Re-authenticate an existing Item in place via Link update mode.

    Use this when a bank forces a re-login (status 'login_required'). It reuses
    the same Item, so unlike unlink + link it costs no slot and keeps history.
    """
    from . import plaid_sync

    conn = db.init()
    row = conn.execute(
        "SELECT item_id, access_token, institution_name FROM items"
        " WHERE institution_name LIKE ?", (f"%{args.institution}%",)).fetchone()
    if row is None:
        print(f"No linked institution matching {args.institution!r}.")
        return 1
    print(f"Re-authenticating {row['institution_name']} in place (no Item consumed).")
    code = _run_link_page(args, access_token=row["access_token"])
    if code == 0:
        conn.execute("UPDATE items SET status='ok' WHERE item_id=?", (row["item_id"],))
    return code


def tailscale_ip() -> str | None:
    """This machine's tailnet address, if it has one.

    Binding to it specifically - rather than 0.0.0.0 - means the dashboard is
    reachable from your own devices and from nothing else on the local network.
    The app has no login, so the network boundary is the only thing guarding it.
    """
    import socket
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except socket.gaierror:
        return None
    for info in infos:
        ip = info[4][0]
        # Tailscale hands out addresses from the 100.64.0.0/10 CGNAT range
        if ip.startswith("100.") and 64 <= int(ip.split(".")[1]) <= 127:
            return ip
    return None


def _port_in_use(host: str, port: int) -> bool:
    import socket
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def cmd_serve(args) -> int:
    import time

    import uvicorn

    host = args.host
    if args.tailscale:
        # At logon this races Tailscale coming up, so wait rather than fail.
        deadline = time.monotonic() + args.wait
        while not (host := tailscale_ip()):
            if time.monotonic() >= deadline:
                print("No tailnet address found. Is Tailscale installed and connected?")
                print("Install from https://tailscale.com/download, sign in, then retry.")
                return 1
            time.sleep(3)
        print(f"Binding to the tailnet address only: {host}")
        print("Reachable from your signed-in devices; invisible to the rest of the LAN.")

    # Scheduled to run periodically so a crashed server comes back; if one is
    # already up that is success, not an error.
    if _port_in_use(host, args.port):
        print(f"Already serving on {host}:{args.port} - nothing to do.")
        return 0

    url = f"http://{host}:{args.port}"
    print(f"spendtrack dashboard -> {url}")
    if not args.no_browser:
        webbrowser.open(url)
    uvicorn.run("spendtrack.api:app", host=host, port=args.port,
                reload=args.reload, log_level="warning")
    return 0


def cmd_link(args) -> int:
    """Connect a new institution. Consumes one of the 10 free Trial Items."""
    return _run_link_page(args)


def _run_link_page(args, access_token: str | None = None) -> int:
    """Serve the one-shot Plaid Link page and wait for the handshake.

    With access_token set this is update mode: it re-authenticates the existing
    Item rather than creating one, so it costs no Item slot and keeps history.
    """
    import threading

    import uvicorn
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse

    from . import plaid_sync

    db.init()  # create the file and schema before the server starts accepting
    api_client = plaid_sync.client()
    link_token = plaid_sync.create_link_token(api_client, access_token=access_token)
    done = threading.Event()
    result = {}

    app = FastAPI(docs_url=None, redoc_url=None)

    @app.get("/", response_class=HTMLResponse)
    def page() -> str:
        return LINK_PAGE.replace("__LINK_TOKEN__", link_token)

    @app.post("/done")
    def finish(payload: dict) -> dict:
        # This runs on the server thread, so it needs that thread's connection -
        # one captured from the main thread raises and loses the access_token
        # after Plaid has already consumed the Item.
        conn = db.init()
        try:
            item_id = plaid_sync.exchange_public_token(conn, api_client, payload["public_token"])
            name = conn.execute(
                "SELECT institution_name FROM items WHERE item_id = ?", (item_id,)
            ).fetchone()["institution_name"]
            result["ok"] = name or item_id
            return {"institution": result["ok"]}
        except Exception as exc:
            result["error"] = str(exc)
            return {"error": str(exc)}
        finally:
            done.set()

    @app.post("/exit")
    def link_exit(payload: dict) -> dict:
        """Link closed without a token. Report why and stay up - dismissing the
        modal by accident should not cost the whole session."""
        if error := payload.get("error"):
            print(f"  Plaid Link exited: {error}")
        else:
            print("  Link dismissed. The tab is still open - press the button to retry.")
        return {}

    config = uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    url = f"http://127.0.0.1:{args.port}"
    print(f"Opening {url} - complete the bank login in your browser.")
    print(f"Waiting up to {args.timeout // 60} minutes. Ctrl-C to give up.")
    webbrowser.open(url)
    try:
        finished = done.wait(timeout=args.timeout)
    except KeyboardInterrupt:
        finished = False
    server.should_exit = True
    thread.join(timeout=5)

    if error := result.get("error"):
        print(f"Link failed: {error}")
        return 1
    if name := result.get("ok"):
        print(f"Linked {name}. Now run: spendtrack sync")
        return 0
    print("Timed out." if not finished else "Link did not complete.")
    return 1


LINK_PAGE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Link an account</title>
<style>
 body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f9f9f7;
      color:#0b0b0b;display:grid;place-items:center;height:100vh;margin:0}
 .c{background:#fcfcfb;border:1px solid rgba(11,11,11,.1);border-radius:12px;
    padding:32px 36px;max-width:440px;text-align:center}
 h1{font-size:19px;margin:0 0 8px}
 p{color:#52514e;margin:0 0 20px}
 button{font:inherit;background:#2a78d6;color:#fff;border:0;border-radius:8px;
        padding:10px 20px;cursor:pointer}
 #msg{margin-top:16px;color:#52514e;min-height:1.6em}
 @media(prefers-color-scheme:dark){body{background:#0d0d0d;color:#fff}
   .c{background:#1a1a19;border-color:rgba(255,255,255,.1)}p,#msg{color:#c3c2b7}}
</style></head><body>
<div class="c">
  <h1>Link a bank or card</h1>
  <p>Credentials go straight to your bank through Plaid. spendtrack only ever
     receives a read-only token.</p>
  <button id="go">Open Plaid Link</button>
  <div id="msg"></div>
</div>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
const msg = document.getElementById('msg');
const go = document.getElementById('go');

if (typeof Plaid === 'undefined') {
  msg.textContent = 'Could not load Plaid Link - check your network and reload.';
  go.disabled = true;
} else {
  const handler = Plaid.create({
    token: '__LINK_TOKEN__',
    onSuccess: async (public_token) => {
      msg.textContent = 'Linking...';
      const r = await fetch('/done', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({public_token})
      }).then(r => r.json());
      msg.textContent = r.error ? ('Failed: ' + r.error)
                                : ('Linked ' + r.institution + '. You can close this tab.');
    },
    // Dismissing the modal leaves this page usable - the button reopens it.
    onExit: (err) => {
      const detail = err
        ? [err.error_code, err.error_message || err.display_message].filter(Boolean).join(': ')
        : null;
      msg.textContent = detail ? ('Exited - ' + detail) : 'Closed. Press the button to try again.';
      fetch('/exit', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({error: detail})
      });
    },
  });
  go.onclick = () => { msg.textContent = ''; handler.open(); };
  handler.open();
}
</script></body></html>"""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="spendtrack", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_link = sub.add_parser("link", help="connect a bank or card through Plaid Link")
    p_link.add_argument("--port", type=int, default=8737)
    p_link.add_argument("--timeout", type=int, default=900,
                        help="seconds to wait for the browser handshake")
    p_link.set_defaults(func=cmd_link)

    p_sync = sub.add_parser("sync", help="pull new transactions")
    p_sync.add_argument("--no-llm", action="store_true",
                        help="skip the LLM fallback; unmatched merchants stay uncategorised")
    p_sync.add_argument("--full", action="store_true",
                        help="replay the whole history instead of only what changed")
    p_sync.add_argument("--log", help="append output here (for scheduled runs)")
    p_sync.set_defaults(func=cmd_sync)

    p_serve = sub.add_parser("serve", help="run the dashboard")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8736)
    p_serve.add_argument("--reload", action="store_true")
    p_serve.add_argument("--no-browser", action="store_true")
    p_serve.add_argument("--tailscale", action="store_true",
                         help="bind to this machine's tailnet address so your phone can reach it")
    p_serve.add_argument("--wait", type=int, default=0,
                         help="seconds to wait for the tailnet address to appear")
    p_serve.add_argument("--log", help="append output here (for scheduled runs)")
    p_serve.set_defaults(func=cmd_serve)

    p_status = sub.add_parser("status", help="show linked institutions and balances")
    p_status.set_defaults(func=cmd_status)

    p_unlink = sub.add_parser("unlink", help="remove an institution (costs a slot to re-add)")
    p_unlink.add_argument("institution", help="substring of the institution name")
    p_unlink.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    p_unlink.set_defaults(func=cmd_unlink)

    p_reauth = sub.add_parser(
        "reauth", help="re-authenticate an institution in place, without using an Item")
    p_reauth.add_argument("institution", help="substring of the institution name")
    p_reauth.add_argument("--port", type=int, default=8737)
    p_reauth.add_argument("--timeout", type=int, default=900)
    p_reauth.set_defaults(func=cmd_reauth)

    args = parser.parse_args(argv)

    if getattr(args, "log", None):
        # line-buffered so a tail of the file is current, and appended so the
        # history of scheduled runs survives
        path = Path(args.log)
        path.parent.mkdir(parents=True, exist_ok=True)
        stream = path.open("a", buffering=1, encoding="utf-8")
        sys.stdout = sys.stderr = stream
        from datetime import datetime
        stamp = datetime.now().isoformat(timespec="seconds")
        print(f"\n=== {args.command} @ {stamp} ===")

    try:
        return args.func(args)
    except RuntimeError as exc:
        # missing config is a user problem, not a crash - say so and stop
        print(f"{exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
