// script.js
// Inventory fetcher and renderer for Kelly's Candles (static, no backend)
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

const SHEET_CSV_URL = toCsvUrl(SHEET_PUBLISHED_URL);

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

function createCard(item) {
	const el = document.createElement('article');
	el.className = 'card';

	const name = item['candle name'] || item['name'] || item['Candle Name'] || item['Name'] || '';
	const scent = item['scent'] || item['Scent'] || '';
	const size = item['size'] || item['Size'] || '';
	const price = item['price'] || item['Price'] || '';
	const quantity = item['quantity'] || item['Quantity'] || '';

	el.innerHTML = `
		<h3 class="product-name">${escapeHtml(name)}</h3>
		<p class="desc">${escapeHtml(scent)} • ${escapeHtml(size)}</p>
		<div class="meta-row"><span class="price">${escapeHtml(price)}</span><span>Qty: ${escapeHtml(quantity)}</span></div>
		<button class="btn" disabled>Contact to Order</button>
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

		available.forEach(item => inventory.appendChild(createCard(item)));
		loading.classList.add('hidden');
		inventory.classList.remove('hidden');
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

document.addEventListener('DOMContentLoaded', function () {
	const yearEl = document.getElementById('year');
	if (yearEl) yearEl.textContent = new Date().getFullYear();
	loadInventory();
});


