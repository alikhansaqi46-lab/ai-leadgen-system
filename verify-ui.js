const http = require('http');

function check(url, name) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log('\n=== ' + name + ' ===');
        console.log('mailto:    ', d.includes('mailto:') ? 'FOUND' : 'MISSING');
        console.log('google maps:', d.includes('google.com/maps') ? 'FOUND' : 'MISSING');
        console.log('target=_blank:', d.includes('target="_blank"') ? 'FOUND' : 'MISSING');
        console.log('rel=noreferrer:', d.includes('rel="noreferrer"') ? 'FOUND' : 'MISSING');
        resolve();
      });
    }).on('error', e => { console.error(name, e.message); resolve(); });
  });
}

(async () => {
  await check('http://localhost:3000/app/leads', 'Leads Page');
  await check('http://localhost:3000/app/scraper', 'Scraper Page');
  await check('http://localhost:3000/app/dashboard', 'Dashboard');
})();
