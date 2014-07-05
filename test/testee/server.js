var vibe = require("../../lib/index");
var url = require("url");
var http = require("http");

var server = vibe.server();
server.on("socket", function(socket) {
    socket.on("echo", function(data) {
        socket.send("echo", data);
    })
    .on("rre.resolve", function(data, reply) {
        reply.resolve(data);
    })
    .on("rre.reject", function(data, reply) {
        reply.reject(data);
    })
    .on("sre.resolve", function(data) {
        socket.send("sre.resolve", data, function(data) {
            socket.send("sre.done", data);
        });
    })
    .on("sre.reject", function(data) {
        socket.send("sre.reject", data, null, function(data) {
            socket.send("sre.done", data);
        });
    });
});

http.createServer().on("request", function(req, res) {
    if (url.parse(req.url).pathname === "/vibe") {
        server.handleRequest(req, res);
    }
})
.on("upgrade", function(req, sock, head) {
    if (url.parse(req.url).pathname === "/vibe") {
        server.handleUpgrade(req, sock, head);
    }
})
.listen(8000);