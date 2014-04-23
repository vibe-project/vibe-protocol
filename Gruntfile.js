module.exports = function(grunt) {
    grunt.registerTask("default", ["test-server", "test-client"]);
    grunt.registerTask("test-client", function() {
        var done = this.async();
        grunt.util.spawn({cmd: "node", opts: {stdio: 'inherit'}, args: ["test/testee/client"]});
        grunt.util.spawn({cmd: "node", opts: {stdio: 'inherit'}, args: ["./node_modules/mocha/bin/mocha", "test/client.js"]}, function(error) {
            done(!error);
        });
    });
    grunt.registerTask("test-server", function() {
        var done = this.async();
        grunt.util.spawn({cmd: "node", opts: {stdio: 'inherit'}, args: ["test/testee/server"]});
        grunt.util.spawn({cmd: "node", opts: {stdio: 'inherit'}, args: ["./node_modules/mocha/bin/mocha", "test/server.js"]}, function(error) {
            done(!error);
        });
    });
};