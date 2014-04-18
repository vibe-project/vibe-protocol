# React protocol

The **React** Protocol is a feature-rich application-level protocol built over HTTP and WebSocket protocol for real-time web application development. It is designed to not only provide a mechanism for applications that need two-way communication with servers but also aim to utilize a full duplex connection for modern web application development by carefully considering known issues and best practices of real-time web.

This project provides a reference implementation and test suite to help write and verify the **React** protocol implementations, which are written in easy to read JavaScript and run on [Node.js](http://nodejs.org). For the reference implementation, their annotated source codes are available at [client.js](http://atmosphere.github.io/react/client.html) and [server.js](http://atmosphere.github.io/react/server.html).

## Testing

In order to test a custom implementation, you need to have Node.js and write a simple testee using the custom implementation, which is a server communicating with the test suite to control tests. Refer to existing [testees](https://github.com/Atmosphere/react-protocol/tree/master/test/testee) written using reference implementations.

Clone a copy of the repository:
```
git clone https://github.com/atmosphere/react-protocol.git
cd react-protocol
```

Install the project's dependencies. In case of Mocha, JavaScript test frameweork, it would be convenient to install as a global package:
```
npm install
npm install -g mocha
```

Run either client or server testee in other console. If you just want to test reference implementation, type either `node test/testee/server` or `node test/testee/server` to test the server or client, respectively.

Then, run the corresponding test suite by typing `mocha test/server` or `mocha test/client`.