var url = require("url"),
    http = require("http"),
    server = require("../../lib/server").server();

server.on("socket", function(socket) {
    socket.on("echo", function(data) {
        socket.send("echo", data);
    })
    .on("reaction", function(bool, reply) {
        if (bool) {
            reply.resolve(bool);
        } else {
            reply.reject(bool);
        }
    });
});

http.createServer().on("request", function(req, res) {
    if (url.parse(req.url).pathname === "/react") {
        server.handleRequest(req, res);
    }
})
.on("upgrade", function(req, sock, head) {
    if (url.parse(req.url).pathname === "/react") {
        server.handleUpgrade(req, sock, head);
    }
})
.listen(8000);