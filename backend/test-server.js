const http = require('http');

// Start the server as a child process
const { spawn } = require('child_process');
const server = spawn('node', ['server.js'], { cwd: __dirname, detached: true });

let output = '';
server.stdout.on('data', (d) => { output += d.toString(); });
server.stderr.on('data', (d) => { output += d.toString(); });

setTimeout(() => {
  const req = http.get('http://localhost:4000/api/health', (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      console.log('HEALTH:', data);
      console.log('SERVER OUTPUT:', output.slice(0, 2000));
      process.kill(-server.pid);
      process.exit(0);
    });
  });
  req.on('error', (err) => {
    console.log('HEALTH ERROR:', err.message);
    console.log('SERVER OUTPUT:', output.slice(0, 2000));
    process.kill(-server.pid);
    process.exit(1);
  });
  req.setTimeout(5000, () => { req.destroy(); });
}, 4000);
