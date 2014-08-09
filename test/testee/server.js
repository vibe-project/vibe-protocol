var vibe = require("../../lib/index");
var url = require("url");
var http = require("http");

var server = vibe.server();
var sockets = {};
server.on("socket", function(socket) {
    // To test protocol
    sockets[socket.id] = socket;
    socket.on("close", function() {
        delete sockets[socket.id];
    })
    .on("echo", function(data) {
        socket.send("echo", data);
    });
    
    // To test extension
    // receiving replyable event
    socket.on("rre.resolve", function(data, reply) {
        reply.resolve(data);
    })
    .on("rre.reject", function(data, reply) {
        reply.reject(data);
    });
    // sending replyable event
    socket.on("sre.resolve", function(data) {
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
    var urlObj = url.parse(req.url, true);
    var query = urlObj.query;
    switch (urlObj.pathname) {
    case "/vibe":
        server.handleRequest(req, res);
        break;
    case "/alive":
        res.end("" + (query.id in sockets));
        break;
    }
})
.on("upgrade", function(req, sock, head) {
    if (url.parse(req.url).pathname === "/vibe") {
        server.handleUpgrade(req, sock, head);
    }
})
.listen(8000);