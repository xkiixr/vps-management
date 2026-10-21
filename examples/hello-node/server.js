const http = require('node:http')

const port = Number(process.env.PORT) || 8080

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    } else if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('hello from vpsm')
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    }
  })
  .listen(port, () => console.log(`listening on ${port}`))
