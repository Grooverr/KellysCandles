// script.js
// Inventory fetcher and renderer for Kelley's Candles (static, no backend)
// Comments explain how the Google Sheets connection works and how to customize.

/*
	HOW TO POINT TO YOUR SHEET
	- The publisher gave this sheet URL (example):
		https://docs.google.com/spreadsheets/d/e/2PACX-1vQ5vb9X2zODGZog-OohXo2DRn_fAZcEODjkxOd8TBIyBwDwHj-ddXEBqvvLlR2vTzmSSoygkc-RvWgE/pubhtml?gid=0&single=true

	- To fetch CSV, convert the published URL by replacing `/pubhtml` with
		`/pub?output=csv` and keep the `gid` query parameter. That produces:
		https://docs.google.com/spreadsheets/d/e/2PACX-1.../pub?output=csv&gid=0

	- Paste the converted CSV URL into `SHEET_CSV_URL` below.
	- After publishing, changes in the Google Sheet will be visible on this site
		(there may be a small publish delay).

	SECURITY NOTE: Published sheets are public. Do not publish private data.
*/

const SHEET_PUBLISHED_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ5vb9X2zODGZog-OohXo2DRn_fAZcEODjkxOd8TBIyBwDwHj-ddXEBqvvLlR2vTzmSSoygkc-RvWgE/pubhtml?gid=0&single=true';

// Convert to CSV endpoint (works for typical 'publish to web' links)
function toCsvUrl(pubHtmlUrl) {
	if (!pubHtmlUrl) return pubHtmlUrl;
	try {
		const u = new URL(pubHtmlUrl);
		// replace trailing /pubhtml with /pub if present
		u.pathname = u.pathname.replace(/\/pubhtml$/i, '/pub');
		// ensure output=csv is present alongside existing params (gid, etc.)
		u.searchParams.set('output', 'csv');
		return u.toString();
	} catch (e) {
		// fallback: naive replace but fix query delimiter if needed
		let out = pubHtmlUrl.replace('/pubhtml', '/pub?output=csv');
		// if we ended with ?output=csv?..., fix to &
		out = out.replace('?output=csv?', '?output=csv&');
		return out;
	}
}

// --- Prevent double submits for Stripe Checkout ---
let checkoutSubmitting = false;

function lockCheckoutUI(isLocked, btn, statusEl, message) {
  if (btn) {
    btn.disabled = isLocked;
    btn.setAttribute("aria-busy", isLocked ? "true" : "false");
    btn.style.opacity = isLocked ? "0.7" : "";
    btn.style.cursor = isLocked ? "not-allowed" : "";
  }
  if (statusEl && typeof message === "string") statusEl.textContent = message;
}

async function runCheckoutOnce({ btn, statusEl, run }) {
  // memory + localStorage lock
  if (checkoutSubmitting) return;
  try {
    if (localStorage.getItem("checkoutInProgress") === "1") return;
  } catch (e) {}

  checkoutSubmitting = true;
  try { localStorage.setItem("checkoutInProgress", "1"); } catch (e) {}

  lockCheckoutUI(true, btn, statusEl, "Redirecting to secure checkout…");

  try {
    await run(); // your existing checkout logic
  } catch (err) {
    console.error("[checkout] failed:", err);
    lockCheckoutUI(false, btn, statusEl, "Checkout failed. Please try again.");
    checkoutSubmitting = false;
    try { localStorage.removeItem("checkoutInProgress"); } catch (e) {}
  }
}




const SHEET_CSV_URL = toCsvUrl(SHEET_PUBLISHED_URL);

/* NEWSLETTER CONFIGURATION
	 - Set `NEWSLETTER_MODE` to 'local' or 'google'.
		 'local' stores signups in localStorage (Option A).
		 'google' will attempt to submit to a Google Form (Option B).
	 - Toggle `NEWSLETTER_ADMIN` to true to enable the "Download signups.csv" button (admin-only).
	 - If using Google Forms (Option B), paste your form action URL and entry name below.
		 Example Form POST action URL (paste here):
			 https://docs.google.com/forms/d/e/FORM_ID/formResponse
		 Example entry name (paste here):
			 entry.1234567890
		 Also paste a view URL (for fallback prefill) if you want the fallback to open the form:
			 https://docs.google.com/forms/d/e/FORM_ID/viewform
*/
const NEWSLETTER_MODE = 'google'; // 'local' or 'google'
const NEWSLETTER_ADMIN = false; // set true to show download button

// GOOGLE FORM CONFIG (Option B) - values provided from your form
const FORM_ACTION_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSc514sYDiILJduMgV5k6Cw-QsDCFh3k-ZyslkeEdlQoOlmOMQ/formResponse';
const ENTRY_EMAIL_NAME = 'entry.36953508'; // email field entry id

// LocalStorage key for signups
const NEWSLETTER_KEY = 'kelleys_newsletter_signups_v1';

// Simple CSV parser that handles quoted fields and commas inside quotes.
function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i+1];

		if (inQuotes) {
			if (ch === '"') {
				if (next === '"') { field += '"'; i++; } else { inQuotes = false; }
			} else { field += ch; }
		} else {
			if (ch === '"') { inQuotes = true; }
			else if (ch === ',') { row.push(field); field = ''; }
			else if (ch === '\r') { continue; }
			else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
			else { field += ch; }
		}
	}
	// last field (if file doesn't end with newline)
	if (field !== '' || row.length) { row.push(field); rows.push(row); }
	return rows;
}

// Convert CSV rows to array of objects using header row
function rowsToObjects(rows) {
	if (!rows || rows.length === 0) return [];
	const headers = rows[0].map(h => h.trim());
	const data = [];
	for (let i = 1; i < rows.length; i++) {
		const r = rows[i];
		if (r.length === 1 && r[0] === '') continue; // skip empty lines
		const obj = {};
		for (let j = 0; j < headers.length; j++) {
			obj[headers[j]] = (r[j] || '').trim();
		}
		data.push(obj);
	}
	return data;
}

// Filter out sold or zero-quantity items
function filterAvailable(items) {
	return items.filter(it => {
		const qty = (it['quantity'] || it['Quantity'] || it['qty'] || it['Qty'] || '').trim();
		const status = (it['status'] || it['Status'] || '').trim().toLowerCase();
		const qtyNum = Number(qty || 0);
		if (status === 'sold out' || status === 'sold' || qtyNum <= 0) return false;
		return true;
	});
}

// In-memory cache of available items for filtering
let AVAILABLE_ITEMS = [];

function normalizeSize(s){
	if (!s) return '';
	return String(s).toLowerCase().replace(/\s+/g,'');
}

function renderAvailable(){
	const inventory = document.getElementById('inventory');
	if (!inventory) return;
	inventory.innerHTML = '';
	const active = document.querySelector('.filter-btn.active');
	const filter = active ? (active.dataset.size || '') : '';
	const items = (AVAILABLE_ITEMS || []).filter(it => {
		if (!filter) return true;
		const sz = normalizeSize(it['size'] || it['Size'] || '');
		return sz === filter || sz.includes(filter);
	});
	if (items.length === 0){
		inventory.innerHTML = '<div class="status">No items match that filter.</div>';
		return;
	}
	items.forEach(item => inventory.appendChild(createCard(item)));
}

function createCard(item) {
	const el = document.createElement('article');
	el.className = 'card';

	const candleName = item['candle name'] || item['Candle Name'] || item['name'] || item['Name'] || '';
	const scent = item['scent'] || item['Scent'] || '';
	const size = item['size'] || item['Size'] || '';
	const price = item['price'] || item['Price'] || '';
	const quantity = item['quantity'] || item['Quantity'] || '';

		// optional image support (display-only).
		// Case-insensitive lookup for common header names and support several variants.
		const desiredKeys = ['image_url','image url','image','photo','picture','img'];
		let imgUrl = '';
		const props = Object.keys(item || {});
		const normMap = {};
		props.forEach(p => { normMap[p.toLowerCase().replace(/[_\s]+/g,'')] = p; });
		for (const dk of desiredKeys){
			const nk = dk.toLowerCase().replace(/[_\s]+/g,'');
			const prop = normMap[nk];
			if (prop){ const val = item[prop]; if (val && String(val).trim()){ imgUrl = String(val).trim(); break; } }
		}
		// If image path is relative (not starting with protocol), convert to absolute using location.origin
		if (imgUrl && !/^[a-z]+:\/\//i.test(imgUrl)){
			imgUrl = (location && location.origin ? String(location.origin).replace(/\/$/,'') : '') + '/' + imgUrl.replace(/^\/+/, '');
		}

		const imgHtml = imgUrl ? `<div class="card-image"><img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(candleName)}" loading="lazy"></div>` : '';

	// Add data attributes so the cart logic can pick up item details. Do NOT include image in cart data.
	el.innerHTML = `
		${imgHtml}
		<h3 class="product-name">${escapeHtml(candleName)}</h3>
		<p class="desc">${escapeHtml(scent)}</p>
		<p class="desc">${escapeHtml(size)}</p>
		<div class="meta-row"><span class="price">${escapeHtml(price)}</span><span>Qty: ${escapeHtml(quantity)}</span></div>
		<div style="margin-top:8px">
			<button class="btn add-to-cart" data-name="${escapeHtml(candleName)}" data-candle-name="${escapeHtml(candleName)}" data-price="${escapeHtml(price)}" data-size="${escapeHtml(size)}" data-scent="${escapeHtml(scent)}">Add to Cart</button>
		</div>
	`;
	return el;
}

function escapeHtml(str) {
	if (!str) return '';
	return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadInventory() {
	const loading = document.getElementById('loading');
	const error = document.getElementById('error');
	const inventory = document.getElementById('inventory');
	if (!loading || !error || !inventory) return;
	loading.classList.remove('hidden');
	error.classList.add('hidden');
	inventory.classList.add('hidden');
	inventory.innerHTML = '';

	if (!SHEET_CSV_URL) {
		loading.classList.add('hidden');
		error.classList.remove('hidden');
		error.textContent = 'No sheet URL configured. Edit script.js to set the published Google Sheet URL.';
		return;
	}

	try {
		const res = await fetch(SHEET_CSV_URL);
		if (!res.ok) throw new Error('Network error: ' + res.status);
		const text = await res.text();
		const rows = parseCsv(text);
		const objs = rowsToObjects(rows);
		const available = filterAvailable(objs);

		if (available.length === 0) {
			loading.classList.add('hidden');
			error.classList.remove('hidden');
			error.textContent = 'No items available right now.';
			return;
		}

		// cache available items and render respecting active filter
		AVAILABLE_ITEMS = available;
		loading.classList.add('hidden');
		inventory.classList.remove('hidden');
		renderAvailable();
		// hide debug link on success
		const csvDebug = document.getElementById('csv-debug');
		if (csvDebug) csvDebug.classList.add('hidden');
	} catch (err) {
		loading.classList.add('hidden');
		error.classList.remove('hidden');
		error.textContent = 'Error loading inventory: ' + err.message;
		// show CSV link for debugging CORS/network issues
		const csvLink = document.getElementById('csv-link');
		const csvDebug = document.getElementById('csv-debug');
		if (csvLink) {
			csvLink.href = SHEET_CSV_URL || '#';
			csvLink.textContent = SHEET_CSV_URL || 'No CSV URL configured';
		}
		if (csvDebug) csvDebug.classList.remove('hidden');
	}
}

const VERCEL_API_BASE = "https://kellyscandles-vercel.vercel.app";

async function payWithCard() {
  console.log("[checkout] Pay with Card clicked");
  const msg = document.getElementById("pay-msg");
  const payBtn = document.getElementById("pay-with-card");
  let overrideMessage = "";

  await runCheckoutOnce({
    btn: payBtn,
    statusEl: msg,
    run: async () => {
      const cart = getCart();
      const email = (document.getElementById("customer-email")?.value || "").trim();

      if (!cart.length) {
        overrideMessage = "Your cart is empty.";
        if (msg) { msg.classList.remove("hidden"); msg.textContent = overrideMessage; }
        // Throw so wrapper unlocks UI + clears localStorage lock
        throw new Error("Cart is empty");
      }

      if (!email) {
        overrideMessage = "Please enter your email for a receipt.";
        if (msg) { msg.classList.remove("hidden"); msg.textContent = overrideMessage; }
        throw new Error("Missing email");
      }

      const url = `${VERCEL_API_BASE}/api/create-checkout-session`;
      console.log("[stripe] create-checkout-session", url);

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cart, customerEmail: email || undefined })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Checkout failed.");

      // Keep lock ON while we redirect (success.html clears it)
      lockCheckoutUI(true, payBtn, msg, "Redirecting to secure checkout to enter shipping details…");
      window.location.href = data.url;
    }
  });

  if (overrideMessage && msg) {
    msg.classList.remove("hidden");
    msg.textContent = overrideMessage;
  }
}

function bindPayWithCard() {
  const payBtn = document.getElementById("pay-with-card");
  if (!payBtn) return;
  if (payBtn.dataset.bound === "1") return;
  payBtn.dataset.bound = "1";
  payBtn.addEventListener("click", payWithCard);
}







document.addEventListener('DOMContentLoaded', function () {
	const yearEl = document.getElementById('year');
	if (yearEl) yearEl.textContent = new Date().getFullYear();
	loadInventory();
	initCartUI();

	// Stripe checkout button
	bindPayWithCard();


	// Reveal homepage image if the user has set a src attribute in index.html
	const siteImg = document.getElementById('site-image');
	if (siteImg) {
		const srcAttr = siteImg.getAttribute('src');
		if (srcAttr && srcAttr.trim() !== '') siteImg.style.display = 'block';
	}

	// Initialize newsletter UI
	initNewsletterUI();

	// DEV: inject a mock product card when previewing on localhost to verify image rendering.
	try{
		if (location && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')){
			const inventory = document.getElementById('inventory');
			if (inventory){
				const demo = {
					'candle name': 'Demo Lilac',
					'Scent': 'Lilac',
					'Size': '12oz',
					'Price': '$18.00',
					'Quantity': '5',
					'Image': 'https://via.placeholder.com/600x400?text=Lilac+Demo'
				};
				// prepend demo card for quick visual check
				inventory.insertBefore(createCard(demo), inventory.firstChild);
			}
		}
	}catch(e){ /* noop */ }
});

/* CART LOGIC */
const CART_KEY = 'kellys_cart_v1';
const GOOGLE_FORM_BASE = 'https://docs.google.com/forms/d/e/1FAIpQLScE5Weub9BdFMp6sQwF9CrLj0ZWlswu5yHQZ3dsPiHS4Y-COg/viewform?usp=pp_url';
const ENTRY_ORDER_DETAILS = '1245959695';
let LAST_ORDER_SUMMARY = '';
function getCart(){
	try{ return JSON.parse(localStorage.getItem(CART_KEY)) || []; }catch(e){ return []; }
}
function saveCart(c){ localStorage.setItem(CART_KEY, JSON.stringify(c)); renderCart(); }
function addToCart(item){
	const cart = getCart();
	// merge by name + size
	const itemName = item.candleName || item.name;
	const idx = cart.findIndex(i => (i.candleName || i.name) === itemName && i.size === item.size);
	if (idx >= 0) cart[idx].qty = (Number(cart[idx].qty)||0) + (Number(item.qty)||1);
	else cart.push({ ...item, qty: Number(item.qty)||1 });
	saveCart(cart);
}
function removeFromCart(index){ const cart = getCart(); cart.splice(index,1); saveCart(cart); }
function updateQty(index, qty){ const cart = getCart(); cart[index].qty = Number(qty)||1; saveCart(cart); }

function initCartUI(){
	// open/close handlers
	const cartBtn = document.getElementById('cart-btn');
	const cartOverlay = document.getElementById('cart-overlay');
	const cartPanel = document.getElementById('cart-panel');
	const cartClose = document.getElementById('cart-close');
	cartBtn && cartBtn.addEventListener('click', () => {
		cartOverlay.classList.remove('hidden');
		cartPanel.classList.remove('hidden');
		document.body.classList.add('cart-open');
		renderCart();
		updateOrderForm(getCart(), true);
		setTimeout(() => updateOrderForm(getCart(), true), 200);
		setTimeout(() => updateOrderForm(getCart(), true), 600);
		cartPanel.addEventListener('transitionend', () => updateOrderForm(getCart(), true), { once: true });
	});
	function closeCart(){
		cartOverlay.classList.add('hidden');
		cartPanel.classList.add('hidden');
		document.body.classList.remove('cart-open');
	}
	cartClose && cartClose.addEventListener('click', closeCart);
	cartOverlay && cartOverlay.addEventListener('click', closeCart);

	// delegation for add-to-cart buttons (inventory is dynamic)
	document.body.addEventListener('click', function(e){
		if (e.target && e.target.matches('.add-to-cart')){
			const b = e.target;
			const candleName = b.dataset.candleName || b.dataset.name || '';
			const item = { candleName, name:candleName, price:b.dataset.price||'', size:b.dataset.size||'', scent:b.dataset.scent||'', qty:1 };
			addToCart(item);
			// brief feedback
			b.textContent = 'Added'; setTimeout(()=> b.textContent = 'Add to Cart',900);
		}
	});

	// checkout form handlers
	const checkoutForm = document.getElementById('checkout-form');
	if (checkoutForm) checkoutForm.addEventListener('submit', handleCheckout);
	const copyBtn = document.getElementById('copy-order');
	if (copyBtn) copyBtn.addEventListener('click', copyOrderToClipboard);

	// Show/hide address field when fulfillment type changes
	const fulfillmentSelect = document.getElementById('fulfillment-select');
	const addressField = document.getElementById('address-field');
	if (fulfillmentSelect && addressField){
		function toggleAddress(){
			if (fulfillmentSelect.value === 'Shipping') addressField.classList.remove('hidden');
			else addressField.classList.add('hidden');
		}
		fulfillmentSelect.addEventListener('change', toggleAddress);
		// initialize
		toggleAddress();
	}

	// Inventory filter buttons
	const filterBtns = document.querySelectorAll('.filter-btn');
	if (filterBtns && filterBtns.length){
		filterBtns.forEach(b=> b.addEventListener('click', (e)=>{
			filterBtns.forEach(x=> x.classList.remove('active'));
			b.classList.add('active');
			renderAvailable();
		}));
	}
}

/* Newsletter UI and behavior */
function validateEmail(email){
	if (!email) return false;
	// basic email regex
	const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return re.test(String(email).toLowerCase());
}

function getLocalSignups(){
	try{ return JSON.parse(localStorage.getItem(NEWSLETTER_KEY)) || []; }catch(e){ return []; }
}

function saveLocalSignup(email){
	const arr = getLocalSignups();
	arr.push({ email: email, ts: new Date().toISOString() });
	localStorage.setItem(NEWSLETTER_KEY, JSON.stringify(arr));
}

function downloadCsv(signups){
	const header = ['email','timestamp'];
	const rows = signups.map(s => [s.email, s.ts]);
	const csv = [header.join(','), ...rows.map(r => r.map(c=> '"'+String(c).replace(/"/g,'""')+'"').join(','))].join('\n');
	const blob = new Blob([csv], { type: 'text/csv' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a'); a.href = url; a.download = 'newsletter_signups.csv'; document.body.appendChild(a); a.click(); a.remove();
	setTimeout(()=> URL.revokeObjectURL(url), 5000);
}

async function submitToGoogleForm(email){
	if (!FORM_ACTION_URL || !ENTRY_EMAIL_NAME) throw new Error('Google Form not configured');
	const fd = new FormData();
	fd.append(ENTRY_EMAIL_NAME, email);
	try{
		await fetch(FORM_ACTION_URL, { method:'POST', mode:'no-cors', body:fd });
		return true;
	}catch(e){
		throw e;
	}
}

function initNewsletterUI(){
	const form = document.getElementById('newsletter-form');
	if (!form) return;
	const emailInput = document.getElementById('newsletter-email');
	const submitBtn = document.getElementById('newsletter-submit');
	const msg = document.getElementById('newsletter-msg');
	const downloadBtn = document.getElementById('download-signups');

	// show admin download button if enabled
	if (NEWSLETTER_ADMIN && downloadBtn){ downloadBtn.style.display='inline-block'; }

	if (downloadBtn){
		downloadBtn.addEventListener('click', ()=>{
			const signups = getLocalSignups();
			downloadCsv(signups);
		});
	}

	form.addEventListener('submit', async (e)=>{
		e.preventDefault();
		msg.classList.add('hidden'); msg.textContent='';
		const email = (emailInput.value || '').trim();
		if (!validateEmail(email)){
			msg.classList.remove('hidden'); msg.textContent = 'Please enter a valid email.'; return;
		}
		submitBtn.disabled = true; submitBtn.textContent = 'Signing…';
		try{
			if (NEWSLETTER_MODE === 'local'){
				saveLocalSignup(email);
				msg.classList.remove('hidden'); msg.textContent = "Thanks! You're signed up.";
			} else {
				// google mode
				try{
					await submitToGoogleForm(email);
					msg.classList.remove('hidden'); msg.textContent = "Thanks! You're signed up.";
				}catch(err){
					msg.classList.remove('hidden'); msg.textContent = 'Could not submit. Please try again.';
				}
			}
			emailInput.value = '';
		}catch(err){
			msg.classList.remove('hidden'); msg.textContent = 'Error saving signup. Try again.';
		}finally{
			submitBtn.disabled = false; submitBtn.textContent = 'Sign Up';
		}
	});
}

function buildOrderSummary(cart){
	let total = 0;
	const lines = [];
	lines.push("Kelley's Candles Order");
	lines.push('----------------------');
	cart.forEach(it => {
		const itemName = it.candleName || it.name || '';
		const priceNum = parseFloat(String(it.price||'').replace(/[^0-9\.\-]/g,'')) || 0;
		const qty = Number(it.qty)||1;
		const lineTotal = priceNum * qty;
		total += lineTotal;
		const variantParts = [it.scent, it.size].filter(Boolean);
		const variant = variantParts.length ? variantParts.join(' • ') : '—';
		lines.push(`Item: ${itemName}`);
		lines.push(`Variant/Size: ${variant}`);
		lines.push(`Qty: ${qty}`);
		lines.push(`Unit Price: $${priceNum.toFixed(2)}`);
		lines.push(`Line Total: $${lineTotal.toFixed(2)}`);
		lines.push('');
	});
	lines.push(`Total: $${total.toFixed(2)}`);
	return lines.join('\n');
}

function buildPrefilledFormUrlFromSummary(summary){
	const encodedSummary = encodeURIComponent(summary);
	return `${GOOGLE_FORM_BASE}&entry.${ENTRY_ORDER_DETAILS}=${encodedSummary}&embedded=true&cachebust=${Date.now()}`;
}

function updateOrderForm(cart, force = false){
	const frame = document.getElementById('order-form-frame');
	if (!frame) return;
	const formCard = frame.closest('.form-card');
	const helper = document.getElementById('order-form-helper');
	const empty = document.getElementById('order-form-empty');
	const followup = document.querySelector('.form-followup');
	if (!cart || cart.length === 0){
		if (formCard) formCard.classList.add('hidden');
		if (helper) helper.classList.add('hidden');
		if (followup) followup.classList.add('hidden');
		if (empty) empty.classList.remove('hidden');
		return;
	}
	if (formCard) formCard.classList.remove('hidden');
	if (helper) helper.classList.remove('hidden');
	if (followup) followup.classList.remove('hidden');
	if (empty) empty.classList.add('hidden');
	const summary = buildOrderSummary(cart);
	if (!force && summary === LAST_ORDER_SUMMARY) return;
	LAST_ORDER_SUMMARY = summary;
	frame.setAttribute('src', 'about:blank');
	setTimeout(() => frame.setAttribute('src', buildPrefilledFormUrlFromSummary(summary)), 0);
}

function renderCart(){
	const cart = getCart();
	const cartItems = document.getElementById('cart-items');
	const cartCount = document.getElementById('cart-count');
	const cartTotal = document.getElementById('cart-total');
	cartItems.innerHTML = '';
	let total = 0;
	cart.forEach((it, idx) =>{
		const priceNum = parseFloat(String(it.price||'').replace(/[^0-9\.\-]/g,'')) || 0;
		total += priceNum * (Number(it.qty)||1);
		const div = document.createElement('div'); div.className='cart-item';
		const displayName = it.candleName || it.name;
		div.innerHTML = `<div class="cart-item-info">
			<div class="product-name">${escapeHtml(displayName)}</div>
			<div class="meta">${escapeHtml(it.scent)}</div>
			<div class="meta">${escapeHtml(it.size)}</div>
		</div>
		<div class="cart-item-actions">
			<div class="item-price">${escapeHtml(it.price)}</div>
			<div class="item-controls">
				<input type="number" min="1" value="${escapeHtml(it.qty)}" data-idx="${idx}" class="qty-input">
				<button data-idx="${idx}" class="btn small remove-btn">Remove</button>
			</div>
		</div>`;
		cartItems.appendChild(div);
	});
	cartCount.textContent = cart.reduce((s,i)=>s+Number(i.qty||0),0);
	cartTotal.textContent = '$' + total.toFixed(2);
	updateOrderForm(cart);
	bindPayWithCard();

	// attach qty and remove handlers
	cartItems.querySelectorAll('.qty-input').forEach(inp=> inp.addEventListener('change', (e)=> updateQty(Number(e.target.dataset.idx), Number(e.target.value) || 1)));
	cartItems.querySelectorAll('.remove-btn').forEach(b => b.addEventListener('click', (e)=> removeFromCart(Number(e.target.dataset.idx))));
}

function buildOrderText(formData){
	const cart = getCart();
	let lines = [];
	lines.push(`Order from Kelley's Candles`);
	lines.push('');
	lines.push('Items:');
	cart.forEach(it=>{ lines.push(`${it.qty} x ${it.candleName || it.name} (${it.size}) — ${it.price}`); });
	lines.push('');
	lines.push('Customer:');
	lines.push(`Name: ${formData.get('name') || ''}`);
	lines.push(`Phone: ${formData.get('phone') || ''}`);
	lines.push(`Address: ${formData.get('address') || ''}`);
	lines.push(`Fulfillment: ${formData.get('fulfillment') || ''}`);
	lines.push(`Payment: ${formData.get('payment') || ''}`);
	lines.push(`Payment user: ${formData.get('payment_user') || ''}`);
	lines.push('');
	lines.push('Comments:');
	lines.push(formData.get('comments') || '');
	return lines.join('\n');
}

/*
 	GOOGLE FORM SETTINGS
 	- Set `GOOGLE_FORM_BASE` to your Google Form URL (the base view URL, e.g.
 		https://docs.google.com/forms/d/e/FORM_ID/viewform)
 	- Fill `GOOGLE_FORM_FIELDS` mapping with your form's entry IDs, e.g.:
 		{ name: 'entry.123456', phone: 'entry.234567', fulfillment: 'entry.345678', payment: 'entry.456789', payment_user: 'entry.567890', comments: 'entry.678901' }
 	- To get entry IDs: open your Google Form, click the three dots → Get pre-filled link,
 		fill example values, then click Get link and inspect the URL's query params (entry.xxxxxx).
 	- The script uses `URL` and `URLSearchParams` to build a safe prefilled URL.
*/
const GOOGLE_FORM_FIELDS = {
 	name: 'entry.549297552',
 	phone: 'entry.722865220',
 	fulfillment: 'entry.673908643',
 	address: 'entry.1385294730',
 	payment: 'entry.1996077415',
 	payment_user: 'entry.1793976992',
 	comments: 'entry.352595684'
};

/*
 	Generate a printable HTML order summary and open print dialog.
 	This produces a formatted HTML page the user can print or save as PDF.
*/
function buildOrderHtml(formData){
 	const cart = getCart();
 	let total = 0;
 	const rows = cart.map(it => {
 		const priceNum = parseFloat(String(it.price||'').replace(/[^0-9\.\-]/g,'')) || 0;
 		total += priceNum * (Number(it.qty)||1);
 		return `<tr>
 			<td>${escapeHtml(it.name)}</td>
 			<td>${escapeHtml(it.size)}</td>
 			<td>${escapeHtml(it.qty)}</td>
 			<td style="text-align:right">${escapeHtml(it.price)}</td>
 		</tr>`;
 	}).join('');

	const html = `<!doctype html><html><head><meta charset="utf-8"><title>Kelley's Candles Order</title>
 	<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;700&family=Playfair+Display:wght@400;700&display=swap" rel="stylesheet">
 	<style>
 	body{ font-family: Lora, serif; margin:20px; color:#3b2f2f; background:#fff; }
 	.header{ border-bottom:4px solid rgba(0,0,0,0.06); padding-bottom:10px; margin-bottom:12px; }
 	.h1{ font-family: 'Playfair Display', serif; font-size:22px; color:#8b5a2b; margin:0; }
 	.meta{ color:#6b6b6b; margin-top:6px; }
 	table{ width:100%; border-collapse:collapse; margin-top:12px; }
 	td,th{ padding:6px 8px; border-bottom:1px solid #eee; }
 	.total{ text-align:right; font-weight:700; margin-top:10px; }
 	.box{ background:#fbf8f4; padding:10px; border-radius:6px; border:1px solid rgba(0,0,0,0.04); }
 	</style>
 	</head><body>
 	<div class="header">
	<div class="h1">Kelley's Candles — Order Summary</div>
 	  <div class="meta">Generated: ${new Date().toLocaleString()}</div>
 	</div>

 	<div class="box">
 	  <h4>Items</h4>
 	  <table>
 	    <thead><tr><th>Product</th><th>Size</th><th>Qty</th><th style="text-align:right">Price</th></tr></thead>
 	    <tbody>
 	      ${rows || '<tr><td colspan="4">No items</td></tr>'}
 	    </tbody>
 	  </table>
 	  <div class="total">Total: $${total.toFixed(2)}</div>
 	</div>

 	<div style="height:12px"></div>
 	<div class="box">
 	  <h4>Customer</h4>
 	  <p><strong>Name:</strong> ${escapeHtml(formData.get('name') || '')}</p>
 	  <p><strong>Phone:</strong> ${escapeHtml(formData.get('phone') || '')}</p>
 	  <p><strong>Address:</strong> ${escapeHtml(formData.get('address') || '')}</p>
 	  <p><strong>Fulfillment:</strong> ${escapeHtml(formData.get('fulfillment') || '')}</p>
 	  <p><strong>Payment:</strong> ${escapeHtml(formData.get('payment') || '')} ${escapeHtml(formData.get('payment_user') || '')}</p>
 	  <p><strong>Comments:</strong> ${escapeHtml(formData.get('comments') || '')}</p>
 	</div>

 	</body></html>`;
 	return html;
}

function openOrderPrintWindow(orderHtml){
 	const w = window.open('', '_blank');
 	if (!w) return false;
 	w.document.open();
 	w.document.write(orderHtml);
 	w.document.close();
 	// wait for fonts/resources then print
 	w.onload = () => {
 		try{ w.focus(); w.print(); }catch(e){}
 		// optional: close after printing
 		setTimeout(()=>{ /* w.close(); */ }, 1000);
 	};
 	return true;
}

function buildPrefillUrl(formData){
 	if (!GOOGLE_FORM_BASE) return null;
 	try{
 		const u = new URL(GOOGLE_FORM_BASE);
 		const params = new URLSearchParams(u.search);
 		// set each mapped field if present
 		if (GOOGLE_FORM_FIELDS.name) params.set(GOOGLE_FORM_FIELDS.name, formData.get('name') || '');
 		if (GOOGLE_FORM_FIELDS.phone) params.set(GOOGLE_FORM_FIELDS.phone, formData.get('phone') || '');
 		if (GOOGLE_FORM_FIELDS.fulfillment) params.set(GOOGLE_FORM_FIELDS.fulfillment, formData.get('fulfillment') || '');
		if (GOOGLE_FORM_FIELDS.address) params.set(GOOGLE_FORM_FIELDS.address, formData.get('address') || '');
 		if (GOOGLE_FORM_FIELDS.payment) params.set(GOOGLE_FORM_FIELDS.payment, formData.get('payment') || '');
 		if (GOOGLE_FORM_FIELDS.payment_user) params.set(GOOGLE_FORM_FIELDS.payment_user, formData.get('payment_user') || '');
		if (GOOGLE_FORM_FIELDS.comments) params.set(GOOGLE_FORM_FIELDS.comments, formData.get('comments') || '');
 		u.search = params.toString();
 		return u.toString();
 	}catch(e){ return null; }
}

async function handleCheckout(e){
 	e.preventDefault();
 	const form = e.target;
 	const fd = new FormData(form);
 	// basic validation: require name and phone
 	if (!fd.get('name') || !fd.get('phone')){
 		const msg = document.getElementById('checkout-msg'); msg.classList.remove('hidden'); msg.textContent='Please provide name and phone.'; return;
 	}

 	// Build printable HTML order summary and open print dialog (user can Save as PDF)
 	const orderHtml = buildOrderHtml(fd);
 	const opened = openOrderPrintWindow(orderHtml);

 	// Build pre-filled Google Form URL and open in new tab for farmer submission
 	const formUrl = buildPrefillUrl(fd);
 	if (formUrl) {
 		window.open(formUrl, '_blank', 'noopener');
 		const msg = document.getElementById('checkout-msg'); msg.classList.remove('hidden'); msg.textContent = opened ? 'Order prepared and print dialog opened; Google Form opened in a new tab.' : 'Order prepared; Google Form opened in a new tab.';
 	} else {
 		const msg = document.getElementById('checkout-msg'); msg.classList.remove('hidden'); msg.textContent = opened ? 'Order prepared and print dialog opened.' : 'Order prepared.';
 	}
}

function copyOrderToClipboard(){
	const form = document.getElementById('checkout-form');
	const fd = new FormData(form);
	const orderText = buildOrderText(fd);
	navigator.clipboard.writeText(orderText).then(()=>{
		const msg = document.getElementById('checkout-msg'); msg.classList.remove('hidden'); msg.textContent = 'Order copied to clipboard — paste into email or message.';
	});
}
