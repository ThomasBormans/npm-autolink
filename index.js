'use strict';

var Promise = require('bluebird');
Promise.longStackTraces();
var fs = Promise.promisifyAll(require('fs-extra'));
var path = require('path');
var glob = Promise.promisify(require('glob'));
var endOfLine = require('os').EOL;
var _ = require('lodash');
var pathIsAbsolute = require('path-is-absolute');
var semver = require('semver');
var chalk = require('chalk');

var nodeModulesPath = path.join(process.cwd(), 'node_modules');

function AutoLinkNotFound() {}
AutoLinkNotFound.prototype = Object.create(Error.prototype);

function getDevPackagesFromPath(autolinkDir) {

    var autolinkPath = path.join(autolinkDir, '.autolink');

    return fs.readFileAsync(autolinkPath)
        .catch(function() {
            return Promise.reject(new AutoLinkNotFound("Error reading .autolink file : " + autolinkPath));
        })
        .then(function(data) {

            var globPatterns = data.toString().split(endOfLine);
            return Promise.all(_.map(globPatterns, function(pattern) {
                if (!pattern) {
                    return;
                }

                return glob(pattern, {
                    cwd: autolinkDir,
                    ignore: ['**/node_modules/**', '**/bower_components/**']
                });
            }))

        })
        .then(function(files) {
            var packages = {};
            _.each(_.flatten(files), function(file) {
                if (!file) {
                    return;
                }
                var absoluteFilePath = pathIsAbsolute(file) ? file : path.join(autolinkDir, file);
                var pack = require(absoluteFilePath);
                var dirname = path.dirname(require.resolve(absoluteFilePath));
                var versions = packages[pack.name];
                if (!versions) {
                    versions = {};
                    packages[pack.name] = versions;
                }
                var currentVersion = versions[pack.version];
                //console.log(pack.name, pack.version, dirname);
                if (currentVersion && currentVersion !== dirname) {
                    console.log(chalk.red("version conflict : ", currentVersion, dirname));
                } else {
                    versions[pack.version] = dirname;
                }
                //console.log(packages);
            });
            return packages;
        });
}

function getDevPackage() {
    var currentDir = process.cwd();

    var promises = [];
    promises.push(getDevPackagesFromPath(currentDir));
    do {
        currentDir = path.dirname(currentDir);
        promises.push(getDevPackagesFromPath(currentDir));
    } while (currentDir !== '/');


    return Promise.settle(promises)
        .then(function(results) {
            var packages = {};
            var autoLinkFound = false;
            var rejections = [];

            _.each(results, function(res) {
                if (res.isFulfilled()) {
                    autoLinkFound = true;
                    _.merge(packages, res.value(), function(a, b) {
                        if (_.isString(a)) {
                            console.log(chalk.red("version conflict : ", a, b));
                        }
                    });
                } else {
                    if (!(res.reason() instanceof AutoLinkNotFound)) {
                        rejections.push(res.reason());
                    }
                }
            });

            if (autoLinkFound) {
                return packages;
            } else if (rejections.length) {
                return Promise.reject(rejections[0].message);
            } else {
                return Promise.reject('No .autolink file could be found');
            }


        });
}

function getMatches() {
    var pack;
    try {
        pack = require(path.join(process.cwd(), 'package.json'));
    } catch (e) {
        return Promise.reject('No package.json found');
    }

    return getDevPackage().then(function(devPackages) {
        var matches = [];
        _.forOwn(_.merge({},
            pack.dependencies,
            pack.devDependencies,
            pack.optionalDependencies), function(range, name) {
            if (devPackages[name]) {
                var devVersions = _.filter(_.keys(devPackages[name]), function(version) {
                    return semver.satisfies(version, range);
                });

                if (devVersions.length) {

                    devVersions = devVersions.sort(semver.rcompare);
                    var bestVersion = devVersions[0];
                    var devPath = devPackages[name][bestVersion];

                    matches.push({
                        name: name,
                        devVersion: bestVersion,
                        requiredRange: range,
                        devPath: devPath
                    });
                }
            }
        });
        return matches;
    });
}

function linkModules(moduleName) {
    return getMatches()
        .then(function(matches) {
            return Promise.all(_.reduce(matches, function(res, match) {
                if (moduleName && moduleName !== match.name) {
                    return res;
                }
                var scopeMatch = match.name.match(/^(@.*)\/.*/);
                var scope;
                if (!!scopeMatch) {
                    scope = scopeMatch[1];
                }

                var scopedPath = (scope) ? path.join(nodeModulesPath, scope) : nodeModulesPath;
                var targetPath = path.join(nodeModulesPath, match.name);
                var sourcePath = match.devPath;

                var backPath = targetPath + '.bak';

                res.push(fs.lstatAsync(targetPath)
                    .catch(function(err) {})
                    .then(function(stat) {
                        if (!stat) {
                            return;
                        }
                        if (stat.isSymbolicLink()) {
                            //If symlink alreadu exist then remove it
                            return fs.removeAsync(targetPath);
                        } else {
                            //if real directory, remove backPath and rename
                            return fs.removeAsync(backPath)
                                .then(function() {
                                    return fs.renameAsync(targetPath, backPath);
                                })

                        }
                    })
                    //Create node directory if doesn't exist.
                    .then(function() {
                        return fs.mkdirsAsync(scopedPath);
                    })
                    //Create symlink
                    .then(function() {
                        return fs.symlinkAsync(sourcePath, targetPath);
                    })
                    .then(function() {
                        return {
                            target: sourcePath,
                            path: targetPath,
                            added : true,
                            version : match.devVersion
                        }
                    }))
                    return res;
            }, []))
        })
}

function removeLinks(moduleName) {
    return listLinks().then(function(links) {
        return Promise.all(_.reduce(links, function(res, link) {
                var linkName = path.basename(link.path);
                if (!moduleName || linkName === moduleName) {
                    res.push(fs.removeAsync(link.path)
                        .then(function() {
                            return fs.renameAsync(link.path + '.bak', link.path);
                        })
                        .catch(function() {})
                        .then(function() {
                            link.removed = true;
                        }));
                }
                return res;
            }, []))
            .then(function() {
                return links;
            });
    });
}

function listLinks() {
    return fs.readdirAsync(nodeModulesPath)
        .then(function(files) {
            return Promise.settle(_.map(files, function(fileName) {
                var file = path.join(nodeModulesPath, fileName);

                return fs.lstatAsync(file)
                    .then(function(stat) {
                        if (stat.isSymbolicLink()) {
                            return fs.readlinkAsync(file);
                        } else {
                            return Promise.reject();
                        }
                    })
                    .then(function(linkTarget) {
                        return {
                            path: file,
                            target: linkTarget,
                            version: require(path.join(linkTarget, 'package.json')).version
                        }
                    })
            }))
        })
        .then(function(res) {
            return _.reduce(res, function(links, item) {
                if (item.isFulfilled()) {
                    links.push(item.value());
                }
                return links;
            }, [])
        })
}

module.exports = {
    getDevPackage: getDevPackage,
    getMatches: getMatches,
    linkModules: linkModules,
    removeLinks: removeLinks,
    listLinks: listLinks
}