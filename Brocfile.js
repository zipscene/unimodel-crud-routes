// Copyright 2016 Zipscene, LLC
// Licensed under the Apache License, Version 2.0
// http://www.apache.org/licenses/LICENSE-2.0

var fs = require('fs');
var Promise = require('es6-promise').Promise;
var esTranspiler = require('broccoli-babel-transpiler');
var mergeTrees = require('broccoli-merge-trees');
var pickFiles = require('broccoli-static-compiler');
var WrapFiles = require('broccoli-wrap');

// Returns a broc tree corresponding to the original source files
function getSourceTrees() {
	var pathsToSearch = [ 'lib', 'src', 'test', 'bin', 'bench' ];

	return {
		read: function(readTree) {
			var promises = pathsToSearch.map(function(path) {
				return new Promise(function(resolve) {
					fs.exists(path, function(exists) {
						if (exists) {
							resolve(path);
						} else {
							resolve();
						}
					});
				});
			});

			return Promise.all(promises).then(function(paths) {
				paths = paths.filter(function(path) { return !!path; });

				if (paths.length === 0) throw new Error('No source paths found');

				console.log('Found source paths: ' + paths.join(', '));

				var pathTrees = paths.map(function(path) {
					return pickFiles(path, {
						srcDir: '.',
						destDir: path
					});
				});

				return readTree(mergeTrees(pathTrees));
			});
		},

		cleanup: function() {}
	};
}

/**
 * Adds an optional dependency to install source tree stack trace support
 * if the relevant package ('source-map-support') is installed.
 * The string in require() is split up to prevent browserify from catching and including it.
 * It's important that this is all on one line because it's prepended to the
 * source before being transpiled, and would mess up line numbers otherwise.
 */
var addSourceMapSupport = function(tree) {
	var sourceMapString = '' +
		'!(function() {try{' +
		'require("s"+"ource-map-support").install();' +
		'}catch(e){}})();';
	return new WrapFiles(tree, {
		wrapper: [ sourceMapString, '' ],
		extensions: [ 'js' ]
	});
};

var addBinShebang = function(tree) {
	var shebangTree = new WrapFiles(tree, {
		wrapper: [ '#!/usr/bin/env node\n', '' ],
		extension: [ 'js' ]
	});

	shebangTree.processString = function(string, relativePath) {
		// Only operate on files in the bin folder
		if (!/^bin\//.test(relativePath)) return string;

		// Run the wrapper on the bin file
		return WrapFiles.prototype.processString.call(this, string, relativePath);
	};

	return shebangTree;
};


var tree = getSourceTrees();
tree = addSourceMapSupport(tree);
tree = esTranspiler(tree);
tree = addBinShebang(tree);

module.exports = tree;
