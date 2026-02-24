const express = require("express");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve /public files like shirt.png and tvll.png
app.use(express.static("public"));

// ====== CONFIG ======
const PRICE_PER_SHIRT = 20;
const VENMO_USERNAME = "dtanque";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const HOLD_MINUTES = parseInt(process.env.HOLD_MINUTES || "20", 10);

// Email / Gmail SMTP
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const FROM_EMAIL = process.env.FROM_EMAIL || SMTP_USER;

const mailer = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

// ====== DB ======
const db = new Database("data.db");
db.pragma("journal_mode = WAL");

// Sizes you want to sell
const SIZES = ["AM", "AL", "AXL", "A2XL"];

// Tables (multi-size cart)
db.exec(`
CREATE TABLE IF NOT EXISTS inventory (
  size TEXT PRIMARY KEY,
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT,
  total INTEGER NOT NULL,
  note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' -- pending, paid, canceled, expired
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  size TEXT NOT NULL,
  qty INTEGER NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);
`);

// Ensure inventory rows exist for all sizes
const insInv = db.prepare("INSERT OR IGNORE INTO inventory(size, qty) VALUES(?, ?)");
SIZES.forEach(s => insInv.run(s, 0));

// ====== HELPERS ======
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function requireAdmin(req, res, next) {
  const pass = req.headers["x-admin-password"] || req.query.password || req.body.password;
  if (pass !== ADMIN_PASSWORD) return res.status(401).send("Unauthorized");
  next();
}

function buildVenmoUrl({ amount, note }) {
  const base = `https://venmo.com/${encodeURIComponent(VENMO_USERNAME)}`;
  const params = new URLSearchParams({
    txn: "pay",
    amount: amount.toFixed(2),
    note
  });
  return `${base}?${params.toString()}`;
}

function isValidEmail(email) {
  return typeof email === "string" && email.includes("@") && email.length <= 254;
}

function formatItems(items) {
  return items.map(i => `${i.qty} x ${i.size}`).join(", ");
}

// Release expired holds: return inventory for pending orders past expires_at
function releaseExpiredHolds() {
  const now = new Date().toISOString();

  const expiredOrders = db.prepare(`
    SELECT id FROM orders
    WHERE status='pending' AND expires_at < ?
  `).all(now);

  if (!expiredOrders.length) return;

  const getItems = db.prepare(`SELECT size, qty FROM order_items WHERE order_id=?`);
  const updInv = db.prepare(`UPDATE inventory SET qty = qty + ? WHERE size=?`);
  const markExp = db.prepare(`UPDATE orders SET status='expired' WHERE id=?`);

  db.transaction(() => {
    for (const o of expiredOrders) {
      const items = getItems.all(o.id);
      for (const it of items) {
        updInv.run(it.qty, it.size);
      }
      markExp.run(o.id);
    }
  })();
}

// Run cleanup each request (fine for low traffic)
app.use((req, res, next) => {
  try { releaseExpiredHolds(); } catch (_) {}
  next();
});

// ====== EMAILS ======
async function sendOrderEmails(order, items, venmoUrl) {
  const subject = `TShirt Order #${order.id} - Pending Venmo Payment`;

  const commonText =
`Order #${order.id} (PENDING - not complete until Venmo payment)
Name: ${order.first_name} ${order.last_name}
Email: ${order.email}
Role: ${order.role || "(none)"}
Items: ${formatItems(items)}
Total: $${order.total}
Venmo note: ${order.note}

IMPORTANT:
- Please do not close your browser tab until you finish payment.
- Your order is not complete until the Venmo transaction is complete.
- This reservation expires at: ${order.expires_at}

Pay here (Venmo): ${venmoUrl}
`;

  await mailer.sendMail({
    from: FROM_EMAIL,
    to: order.email,
    subject,
    text: `Thanks! We reserved your shirts.\n\n${commonText}`
  });

  await mailer.sendMail({
    from: FROM_EMAIL,
    to: ADMIN_EMAIL,
    subject: `ADMIN COPY: ${subject}`,
    text: commonText
  });
}

async function sendPaidConfirmationEmail(order, items) {
  const subject = `TShirt Order #${order.id} – Payment Received`;

  const body =
`Thank you for your payment!

We have received your Venmo payment for your Tanque Verde Little League Softball order.

Order details:
Name: ${order.first_name} ${order.last_name}
Email: ${order.email}
Role: ${order.role || "(none)"}
Items: ${formatItems(items)}
Total Paid: $${order.total}

Pickup information:
• You may pick up your shirt(s) from your coach, OR
• Contact Tracey Lisacki for pickup instructions

Thank you for supporting the team!
`;

  await mailer.sendMail({
    from: FROM_EMAIL,
    to: order.email,
    subject,
    text: body
  });

  await mailer.sendMail({
    from: FROM_EMAIL,
    to: ADMIN_EMAIL,
    subject: `ADMIN COPY: ${subject}`,
    text: body
  });
}

// ====== PUBLIC API ======
app.get("/", (req, res) => {
  res.type("html").send(renderShopPage());
});

app.get("/api/inventory", (req, res) => {
  const inv = db.prepare("SELECT size, qty FROM inventory ORDER BY size").all();
  res.json({ price: PRICE_PER_SHIRT, sizes: SIZES, inventory: inv });
});

app.post("/api/create-order", async (req, res) => {
  const firstName = (req.body.firstName || "").trim();
  const lastName  = (req.body.lastName || "").trim();
  const email     = (req.body.email || "").trim();
  const role      = (req.body.role || "").trim();
  const items     = Array.isArray(req.body.items) ? req.body.items : [];

  if (!firstName || !lastName) return res.status(400).json({ error: "First and last name required." });
  if (!isValidEmail(email)) return res.status(400).json({ error: "Valid email required." });

  // Validate cart items
  const cleanItems = [];
  for (const it of items) {
    const size = (it.size || "").trim();
    const qty = parseInt(it.qty, 10);
    if (!size || !SIZES.includes(size)) continue;
    if (!Number.isInteger(qty) || qty <= 0) continue;
    cleanItems.push({ size, qty });
  }
  if (cleanItems.length === 0) return res.status(400).json({ error: "Add at least one size/quantity." });

  // Combine duplicate sizes
  const merged = new Map();
  for (const it of cleanItems) merged.set(it.size, (merged.get(it.size) || 0) + it.qty);
  const finalItems = Array.from(merged.entries()).map(([size, qty]) => ({ size, qty }));

  const totalQty = finalItems.reduce((sum, it) => sum + it.qty, 0);
  if (totalQty > 50) return res.status(400).json({ error: "Total quantity too large (max 50)." });

  const total = PRICE_PER_SHIRT * totalQty;
  const note = `Softball Fan TShirt- ${lastName}`;

  const now = new Date();
  const expires = new Date(now.getTime() + HOLD_MINUTES * 60 * 1000);

  const getInv = db.prepare("SELECT qty FROM inventory WHERE size=?");
  const decInv = db.prepare("UPDATE inventory SET qty = qty - ? WHERE size=?");

  const insOrder = db.prepare(`
    INSERT INTO orders(created_at, expires_at, first_name, last_name, email, role, total, note, status)
    VALUES(?,?,?,?,?,?,?,?, 'pending')
  `);

  const insItem = db.prepare(`
    INSERT INTO order_items(order_id, size, qty) VALUES(?,?,?)
  `);

  let orderId;

  try {
    // ✅ Use lastInsertRowid from better-sqlite3 to avoid undefined order
    db.transaction(() => {
      // Check inventory first
      for (const it of finalItems) {
        const row = getInv.get(it.size);
        if (!row || row.qty < it.qty) throw new Error(`Not enough inventory for size ${it.size}.`);
      }

      // Decrement inventory
      for (const it of finalItems) {
        decInv.run(it.qty, it.size);
      }

      // Insert order and capture id
      const info = insOrder.run(
        now.toISOString(),
        expires.toISOString(),
        firstName,
        lastName,
        email,
        role || null,
        total,
        note
      );
      orderId = Number(info.lastInsertRowid);

      // Insert items
      for (const it of finalItems) insItem.run(orderId, it.size, it.qty);
    })();

    const venmoUrl = buildVenmoUrl({ amount: total, note });

    // Email buyer + admin (do not fail the order if email fails)
    const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
    const orderItems = db.prepare("SELECT size, qty FROM order_items WHERE order_id=? ORDER BY size").all(orderId);

    if (!order) {
      console.error("Order email failed: order not found for id", orderId);
    } else {
      try {
        await sendOrderEmails(order, orderItems, venmoUrl);
      } catch (e) {
        console.error("Order email failed:", e.message);
      }
    }

    res.json({
      orderId,
      total,
      note,
      expiresAt: expires.toISOString(),
      venmoUrl
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ====== ADMIN ======
app.get("/admin", requireAdmin, (req, res) => {
  const inv = db.prepare("SELECT size, qty FROM inventory ORDER BY size").all();

  const orders = db.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT 200`).all();
  const itemsByOrder = new Map();
  const items = db.prepare(`SELECT order_id, size, qty FROM order_items ORDER BY order_id DESC, size`).all();
  for (const it of items) {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push({ size: it.size, qty: it.qty });
  }

  res.type("html").send(renderAdminPage(inv, orders, itemsByOrder));
});

app.post("/admin/set-inventory", requireAdmin, (req, res) => {
  const size = (req.body.size || "").trim();
  const qty = parseInt(req.body.qty, 10);
  if (!SIZES.includes(size) || !Number.isInteger(qty) || qty < 0) return res.status(400).send("Bad input");

  db.prepare("UPDATE inventory SET qty=? WHERE size=?").run(qty, size);
  res.redirect(`/admin?password=${encodeURIComponent(req.body.password)}`);
});

app.post("/admin/cancel", requireAdmin, (req, res) => {
  const id = parseInt(req.body.id, 10);
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(id);

  if (order && order.status === "pending") {
    const orderItems = db.prepare("SELECT size, qty FROM order_items WHERE order_id=?").all(id);
    db.transaction(() => {
      for (const it of orderItems) {
        db.prepare("UPDATE inventory SET qty = qty + ? WHERE size=?").run(it.qty, it.size);
      }
      db.prepare("UPDATE orders SET status='canceled' WHERE id=?").run(id);
    })();
  }

  res.redirect(`/admin?password=${encodeURIComponent(req.body.password)}`);
});

app.post("/admin/mark-paid", requireAdmin, async (req, res) => {
  const id = parseInt(req.body.id, 10);
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(id);

  if (!order || order.status !== "pending") {
    return res.redirect(`/admin?password=${encodeURIComponent(req.body.password)}`);
  }

  db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(id);

  const orderItems = db.prepare("SELECT size, qty FROM order_items WHERE order_id=? ORDER BY size").all(id);

  try {
    await sendPaidConfirmationEmail(order, orderItems);
  } catch (e) {
    console.error("Paid confirmation email failed:", e.message);
  }

  res.redirect(`/admin?password=${encodeURIComponent(req.body.password)}`);
});

// ====== UI PAGES ======
function renderShopPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Tanque Verde Little League Softball</title>
  <style>
    body{font-family:system-ui,Arial;max-width:820px;margin:40px auto;padding:0 16px;}

    .logo{
      display:block;
      margin: 0 auto 8px auto;
      max-width: 160px;
      height: auto;
      border: none;
      outline: none;
      box-shadow: none;
    }

    h1{
      text-align:center;
      color:#4169E1; /* Royal Blue */
      margin: 0 0 20px 0;
    }

    label{display:block;margin-top:12px;font-weight:600}
    input,select,button{font-size:16px;padding:10px;width:100%;max-width:640px;box-sizing:border-box}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .row > div{flex:1;min-width:240px}
    .card{border:1px solid #ddd;border-radius:10px;padding:16px;margin-top:18px}
    .muted{color:#666}
    button{cursor:pointer}
    .warn{background:#fff7e6;border-color:#ffd59a}
    table{width:100%;border-collapse:collapse;margin-top:10px}
    th,td{border:1px solid #e5e5e5;padding:8px;text-align:left}
    .imgwrap{display:flex;gap:18px;align-items:flex-start;margin-top:18px;flex-wrap:wrap}
    .shirtimg{max-width:220px;border:1px solid #eee;border-radius:10px}
    .smallbtn{padding:8px 10px;font-size:14px;max-width:220px}
  </style>
</head>
<body>
  <img src="/tvll.png" alt="TVLL Logo" class="logo" />
  <h1>Tanque Verde Little League Softball Fan Shirt Order Form</h1>

  <div class="imgwrap">
    <img class="shirtimg" src="/shirt.png" alt="Shirt" />
    <div class="muted">
      $20 per shirt. After you submit, Venmo will open to pay <b>@${VENMO_USERNAME}</b>.
      <br/><b>Please do not close this tab</b> until you complete the Venmo payment.
      <br/><b>Your order is not complete</b> until the Venmo transaction is finished.
    </div>
  </div>

  <div class="card warn">
    <b>Important:</b> Clicking “Pay with Venmo” reserves your shirts for ${HOLD_MINUTES} minutes.
    Your order is only complete after you finish the Venmo payment.
  </div>

  <div class="card">
    <div class="row">
      <div>
        <label>First name *</label>
        <input id="firstName" autocomplete="given-name" />
      </div>
      <div>
        <label>Last name *</label>
        <input id="lastName" autocomplete="family-name" />
      </div>
    </div>

    <label>Email *</label>
    <input id="email" type="email" autocomplete="email" placeholder="you@example.com" />

    <label>Player / Coach (optional)</label>
    <input id="role" placeholder="e.g., Coach Mike or Player Ava"/>

    <div class="card" style="background:#fafafa">
      <div><b>Shirt sizes</b></div>

      <table>
        <thead>
          <tr><th>Size</th><th style="width:140px">Qty</th><th style="width:120px">Remove</th></tr>
        </thead>
        <tbody id="cartBody"></tbody>
      </table>

      <button class="smallbtn" id="addRowBtn" type="button">Add another size</button>
      <div id="stockHint" class="muted" style="margin-top:10px"></div>
    </div>

    <div class="card" style="background:#fafafa">
      <div><b>Preview</b></div>
      <div id="preview" class="muted" style="margin-top:8px">Loading…</div>
    </div>

    <button id="payBtn" style="margin-top:14px">Pay with Venmo</button>
    <div id="msg" class="muted" style="margin-top:10px"></div>
    <div id="fallbackLink" style="margin-top:10px"></div>
  </div>

<script>
let price = 15;
let sizes = [];
let inventory = [];

function money(n){ return "$" + n.toFixed(2); }
function getStock(size){
  const it = inventory.find(x => x.size === size);
  return it ? it.qty : 0;
}

function cartItems() {
  const rows = Array.from(document.querySelectorAll(".cartRow"));
  const items = [];
  for (const r of rows) {
    const size = r.querySelector(".sizeSel").value;
    const qty = parseInt(r.querySelector(".qtyInp").value, 10) || 0;
    if (qty > 0) items.push({ size, qty });
  }
  return items;
}

function totalQty(items) {
  return items.reduce((s,i)=>s+i.qty,0);
}

function merge(items){
  const m = new Map();
  for (const it of items) m.set(it.size, (m.get(it.size)||0) + it.qty);
  return Array.from(m.entries()).map(([size, qty]) => ({size, qty}));
}

function updatePreview(){
  const firstName = document.getElementById("firstName").value.trim();
  const lastName  = document.getElementById("lastName").value.trim();
  const email     = document.getElementById("email").value.trim();
  const role      = document.getElementById("role").value.trim();

  const items = merge(cartItems());
  const qtySum = totalQty(items);
  const total = price * qtySum;
  const note = lastName ? \`Softball Fan TShirt- \${lastName}\` : "Softball Fan TShirt- LASTNAME";
  const itemsText = items.length ? items.map(i => \`\${i.qty}×\${i.size}\`).join(", ") : "(none)";

  const hints = items.map(i => \`\${i.size}: in stock \${getStock(i.size)}\`).join(" | ");
  document.getElementById("stockHint").textContent = hints ? ("Stock: " + hints) : "";

  document.getElementById("preview").innerHTML =
    \`Name: <b>\${firstName || "First"}</b> <b>\${lastName || "Last"}</b><br/>\` +
    \`Email: <b>\${email || "you@example.com"}</b><br/>\` +
    \`Role: \${role || "(none)"}<br/>\` +
    \`Order: \${itemsText}<br/>\` +
    \`Total shirts: <b>\${qtySum}</b><br/>\` +
    \`Total: <b>\${money(total)}</b><br/>\` +
    \`Venmo note will be: <b>\${note}</b>\`;
}

function addCartRow(defaultSize){
  const tbody = document.getElementById("cartBody");
  const tr = document.createElement("tr");
  tr.className = "cartRow";
  tr.innerHTML = \`
    <td><select class="sizeSel"></select></td>
    <td><input class="qtyInp" type="number" min="0" max="50" value="1" /></td>
    <td><button type="button" class="smallbtn removeBtn">Remove</button></td>
  \`;
  tbody.appendChild(tr);

  const sel = tr.querySelector(".sizeSel");
  sel.innerHTML = sizes.map(s => \`<option value="\${s}">\${s}</option>\`).join("");
  if (defaultSize) sel.value = defaultSize;

  tr.querySelector(".removeBtn").addEventListener("click", () => {
    tr.remove();
    updatePreview();
  });

  sel.addEventListener("change", updatePreview);
  tr.querySelector(".qtyInp").addEventListener("input", updatePreview);
  updatePreview();
}

async function loadInventory(){
  const r = await fetch("/api/inventory");
  const data = await r.json();
  price = data.price;
  sizes = data.sizes;
  inventory = data.inventory;

  document.getElementById("cartBody").innerHTML = "";
  addCartRow(sizes[0]);
  updatePreview();
}

document.getElementById("addRowBtn").addEventListener("click", () => addCartRow(sizes[0]));
["firstName","lastName","email","role"].forEach(id=>{
  document.addEventListener("input", (e)=>{ if(e.target && e.target.id===id) updatePreview(); });
});

document.getElementById("payBtn").addEventListener("click", async () => {
  document.getElementById("fallbackLink").innerHTML = "";

  const payload = {
    firstName: document.getElementById("firstName").value.trim(),
    lastName:  document.getElementById("lastName").value.trim(),
    email:     document.getElementById("email").value.trim(),
    role:      document.getElementById("role").value.trim(),
    items:     cartItems()
  };

  document.getElementById("msg").textContent =
    "Creating order and reserving inventory… (Do not close this tab)";

  const r = await fetch("/api/create-order", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });

  const data = await r.json();
  if(!r.ok){
    document.getElementById("msg").textContent = data.error || "Error";
    await loadInventory();
    return;
  }

  document.getElementById("msg").innerHTML =
    \`Order created. Reserved until <b>\${new Date(data.expiresAt).toLocaleTimeString()}</b>.
    Opening Venmo…\`;

  // Open Venmo in a new tab/window
  const w = window.open(data.venmoUrl, "_blank", "noopener,noreferrer");
  if (!w) {
    document.getElementById("fallbackLink").innerHTML =
      \`Popup blocked. Tap this to open Venmo: <a href="\${data.venmoUrl}" target="_blank" rel="noopener noreferrer">Open Venmo Payment</a>\`;
  }
});

loadInventory();
</script>
</body>
</html>`;
}

function renderAdminPage(inv, orders, itemsByOrder) {
  const invRows = inv.map(i => `
    <tr>
      <td>${escapeHtml(i.size)}</td>
      <td>${i.qty}</td>
      <td>
        <form method="POST" action="/admin/set-inventory">
          <input type="hidden" name="password" value="${escapeHtml(ADMIN_PASSWORD)}" />
          <input type="hidden" name="size" value="${escapeHtml(i.size)}" />
          <input name="qty" type="number" min="0" value="${i.qty}" style="width:120px"/>
          <button type="submit">Update</button>
        </form>
      </td>
    </tr>
  `).join("");

  const orderRows = orders.map(o => {
    const items = itemsByOrder.get(o.id) || [];
    const itemText = items.length ? items.map(it => `${it.qty}×${it.size}`).join(", ") : "";
    return `
      <tr>
        <td>${o.id}</td>
        <td>${escapeHtml(o.status)}</td>
        <td>${escapeHtml(o.first_name)} ${escapeHtml(o.last_name)}</td>
        <td>${escapeHtml(o.email)}</td>
        <td>${escapeHtml(o.role || "")}</td>
        <td>${escapeHtml(itemText)}</td>
        <td>$${o.total}</td>
        <td>${escapeHtml(o.note)}</td>
        <td>${escapeHtml(o.created_at)}</td>
        <td>${escapeHtml(o.expires_at)}</td>
        <td>
          <form method="POST" action="/admin/mark-paid" style="display:inline">
            <input type="hidden" name="password" value="${escapeHtml(ADMIN_PASSWORD)}" />
            <input type="hidden" name="id" value="${o.id}" />
            <button ${o.status!=="pending" ? "disabled":""}>Mark paid</button>
          </form>
          <form method="POST" action="/admin/cancel" style="display:inline">
            <input type="hidden" name="password" value="${escapeHtml(ADMIN_PASSWORD)}" />
            <input type="hidden" name="id" value="${o.id}" />
            <button ${o.status!=="pending" ? "disabled":""}>Cancel</button>
          </form>
        </td>
      </tr>
    `;
  }).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Admin</title>
  <style>
    body{font-family:system-ui,Arial;max-width:1300px;margin:40px auto;padding:0 16px;}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #ddd;padding:8px;font-size:14px;vertical-align:top}
    th{background:#f5f5f5}
    button{padding:6px 10px}
  </style>
</head>
<body>
  <h1>Admin</h1>
  <p>Pending orders reserve inventory for ${HOLD_MINUTES} minutes. Expired holds auto-return to inventory.</p>

  <h2>Inventory</h2>
  <table>
    <tr><th>Size</th><th>Qty</th><th>Update</th></tr>
    ${invRows}
  </table>

  <h2 style="margin-top:28px">Recent Orders</h2>
  <table>
    <tr>
      <th>ID</th><th>Status</th><th>Name</th><th>Email</th><th>Role</th><th>Items</th>
      <th>Total</th><th>Note</th><th>Created</th><th>Expires</th><th>Actions</th>
    </tr>
    ${orderRows}
  </table>
</body>
</html>`;
}

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on http://localhost:" + PORT));
