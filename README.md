# ThriftLux

Affordable luxury, always. Curated thrift handbags from Nairobi.

Live: [@thriftlux.ke on Instagram](https://www.instagram.com/thriftlux.ke/)
WhatsApp orders: 0705 044 940 (Venessa)

## Stack

Plain static site — HTML, CSS, JavaScript. No build step, no framework.

```
index.html      Public gallery
admin.html      Owner panel (password-protected, see admin.js)
data.json       Bag inventory (name, price, image, sold status, reel link)
main.js         Gallery logic + lightbox + WhatsApp deeplinks
admin.js        CRUD on bags + AI description generator + import/export
styles.css      Black & gold theme, 4:5 product cards, mobile-first
images/         Logo, favicons, bag photos
```

## Run locally

```bash
python -m http.server 8765
```

Then open [http://localhost:8765](http://localhost:8765).

## Deploy

Drop the folder on any static host. Recommended:

- **GitHub Pages**: push to `main`, enable Pages on the repo, point to `/` (root).
- **Netlify** or **Cloudflare Pages**: drag and drop the folder, done.

## Owner workflow

1. Open `/admin.html`, log in (default password: `thriftlux2026` — change in `admin.js` before going live).
2. Add a new bag: upload image, fill name/price/Instagram reel URL. Click "Suggest description" for an offline AI-generated starter description, then edit to taste.
3. Mark items as sold with one click. Sold bags stay visible with a SOLD badge so the catalogue keeps growing.
4. When done, click **Export data.json** and replace the file on your host. Done.

## Credits

Design and build: [Essence Automations](https://essenceautomations.com/websites)
