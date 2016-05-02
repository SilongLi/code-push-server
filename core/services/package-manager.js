'use strict';
var Q = require('q');
var Promise = Q.Promise;
var models = require('../../models');
var security = require('../../core/utils/security');
var _ = require('lodash');
var qetag = require('../utils/qetag');
var formidable = require('formidable');
var recursiveFs = require("recursive-fs");
var yazl = require("yazl");
var fs = require("fs");
var slash = require("slash");
var common = require('../utils/common');
var os = require('os');
var path = require('path');
var mkdirp = require("mkdirp");
var sortObj = require('sort-object');
var config    = _.get(require('../config'), 'qiniu', {});

var proto = module.exports = function (){
  function PackageManager() {

  }
  PackageManager.__proto__ = proto;
  return PackageManager;
};

proto.parseReqFile = function (req) {
  return Promise(function (resolve, reject, notify) {
    var form = new formidable.IncomingForm();
    form.parse(req, function(err, fields, files) {
      if (err) {
        reject({message: "upload error"});
      } else {
        if (_.isEmpty(fields.packageInfo) || _.isEmpty(files.package)) {
          reject({message: "upload info lack"});
        } else {
          resolve({packageInfo:JSON.parse(fields.packageInfo), package: files.package});
        }
      }
    });
  });
};

proto.hashAllFiles = function (files) {
  return Promise(function (resolve, reject, notify) {
    var results = {};
    var length = files.length;
    var count = 0;
    files.forEach(function (file) {
      security.fileSha256(file).then(function (hash) {
        results[file] = hash;
        count++;
        if (count == length) {
          resolve(results);
        }
      });
    });
  });
};

proto.getDeploymentsVersions = function (deploymentId, appVersion) {
  return models.DeploymentsVersions.findOne({
    where: {deployment_id: deploymentId, app_version: appVersion}
  });
};

proto.calcPackageAllFiles = function (directoryPath) {
  var _this = this;
  return Promise(function (resolve, reject, notify) {
    recursiveFs.readdirr(directoryPath, function (error, directories, files) {
      if (error) {
        reject(error);
      } else {
        if (files.length == 0) {
          reject({message: "empty files"});
        }else {
          _this.hashAllFiles(files).then(function (results) {
            var data = {};
            _.forIn(results, function (value, key) {
              var relativePath = path.relative(directoryPath, key);
              relativePath = slash(relativePath);
              data[relativePath] = value;
            });
            data = sortObj(data);
            resolve(data);
          });
        }
      }
    });
  });
};

proto.existPackageHash = function (deploymentId, appVersion, packageHash) {
  return this.getDeploymentsVersions(deploymentId, appVersion).then(function (data) {
    if (_.isEmpty(data)){
      return models.DeploymentsVersions.create({
        deployment_id: deploymentId,
        app_version: appVersion,
        is_mandatory: false,
      }).then(function () {
        return false;
      });
    } else {
      var packageId = data.current_package_id;
      if (_.gt(packageId, 0)) {
        return models.Packages.findOne({
          where: {id: packageId}
        }).then(function (data) {
          if (_.eq(_.get(data,"package_hash"), packageHash)){
            return true;
          }else {
            return false;
          }
        });
      }else {
        return false
      }
    }
  });
};

proto.createPackage = function (deploymentId, appVersion, packageHash, manifestHash, blobHash, params) {
  var releaseMethod = params.releaseMethod || 'Upload';
  var releaseUid = params.releaseUid || 0;
  var isMandatory = params.isMandatory ? 1 : 0;
  var size = params.size || 0;
  var description = params.description || "";
  var originalLabel = params.originalLabel || "";
  var originalDeployment = params.originalDeployment || "";
  return models.Deployments.generateLabelId(deploymentId).then(function (labelId) {
    return models.sequelize.transaction(function (t) {
      return models.Packages.create({
        deployment_id: deploymentId,
        description: description,
        package_hash: packageHash,
        blob_url: blobHash,
        size: size,
        manifest_blob_url: manifestHash,
        release_method: releaseMethod,
        label: "v" + labelId,
        released_by: releaseUid,
        original_label: originalLabel,
        original_deployment: originalDeployment
      },{transaction: t
      }).then(function (packages) {
        return models.DeploymentsVersions.findOne({where: {deployment_id: deploymentId, app_version: appVersion}})
        .then(function (deploymentsVersions) {
          if (_.isEmpty(deploymentsVersions)) {
            return models.DeploymentsVersions.create({
              is_mandatory: isMandatory,
              current_package_id: packages.id,
              deployment_id: deploymentId,
              app_version: appVersion
            },
            {transaction: t})
          } else {
            deploymentsVersions.set('is_mandatory', isMandatory);
            deploymentsVersions.set('current_package_id', packages.id);
            return deploymentsVersions.save({transaction: t});
          }
        }).then(function (deploymentsVersions) {
          return models.Deployments.update({
            last_deployment_version_id: deploymentsVersions.id
          },{where: {id: deploymentId}, transaction: t});
        }).then(function () {
          return packages;
        });
      });
    });
  });
};

proto.downloadPackageAndExtract = function (workDirectoryPath, packageHash, manifestBlobHash, blobHash) {
  var downloadURL1 = _.get(config, 'downloadUrl') + '/' + manifestBlobHash;
  var downloadURL2 = _.get(config, 'downloadUrl') + '/' + blobHash;
  return common.createEmptyTempFolder(workDirectoryPath).then(function () {
    return Q.allSettled([
      common.createFileFromRequest(downloadURL2, `${workDirectoryPath}/${blobHash}`),
      common.createFileFromRequest(downloadURL1, `${workDirectoryPath}/${manifestBlobHash}`)
    ]).spread(function (r, r2) {
      return common.unzipFile(`${workDirectoryPath}/${blobHash}`, `${workDirectoryPath}/new`);
    });
  });
}

proto.zipDiffPackage = function (fileName, files, baseDirectoryPath, hotcodepushFile) {
  return Promise(function (resolve, reject, notify) {
    var zipFile = new yazl.ZipFile();
    var writeStream = fs.createWriteStream(fileName);
    zipFile.outputStream.pipe(writeStream).on("error", function (error) {
      reject(error);
    }).on("close", function () {
      resolve({ isTemporary: true, path: fileName });
    });
    for (var i = 0; i < files.length; ++i) {
        var file = files[i];
        zipFile.addFile(`${baseDirectoryPath}/${file}`, slash(file));
    }
    zipFile.addFile(hotcodepushFile, 'hotcodepush.json');
    zipFile.end();
  });
}

proto.generateOneDiffPackage = function (workDirectoryPath, packageId, originManifestBlobHash, diffPackageHash, diffManifestBlobHash) {
  var _this = this;
  return models.PackagesDiff.findOne({where:{package_id: packageId, diff_against_package_hash: diffPackageHash}})
  .then(function (diffPackage) {
    if (!_.isEmpty(diffPackage)) {
      return null;
    }
    var downloadURL = _.get(config, 'downloadUrl') + '/' + diffManifestBlobHash;
    return common.createFileFromRequest(downloadURL, `${workDirectoryPath}/${diffManifestBlobHash}`).then(function(){
      try {
        var fileContent1 = JSON.parse(fs.readFileSync(`${workDirectoryPath}/${originManifestBlobHash}`, "utf8"))
        var fileContent2 = JSON.parse(fs.readFileSync(`${workDirectoryPath}/${diffManifestBlobHash}`, "utf8"))
        var json = common.diffCollections(fileContent1, fileContent2);
        var files =  _.concat(json.diff, json.collection1Only);
        var hotcodepush = {deletedFiles: json.collection2Only};
        var hotcodepushFile = `${workDirectoryPath}/${diffManifestBlobHash}_hotcodepush`;
        fs.writeFileSync(hotcodepushFile, JSON.stringify(hotcodepush));
        var baseDirectoryPath = `${workDirectoryPath}/new`;
        var fileName = `${workDirectoryPath}/${diffManifestBlobHash}.zip`;
        return _this.zipDiffPackage(fileName, files, baseDirectoryPath, hotcodepushFile).then(function (data) {
          return security.qetag(fileName).then(function (diffHash) {
            return common.uploadFileToQiniu(diffHash, fileName).then(function () {
                var stats = fs.statSync(fileName);
                return models.PackagesDiff.create({package_id:packageId, diff_against_package_hash:diffPackageHash, diff_blob_url:diffHash, diff_size:stats.size});
            })
          });
        });
      }catch (e) {

      }
      return null;
    });
  });
}

proto.createDiffPackages = function (packageId, num) {
  var _this = this;
  return models.Packages.findById(packageId).then(function (data) {
    if (_.isEmpty(data)) {
      throw Error('can\'t find Package');
    }
    return models.Packages.findAll({where:{deployment_id: data.deployment_id, id: {$lt: packageId}}, order:[['id','desc']], limit:num }).then(function (lastNumsPackages) {
      if (_.isEmpty(lastNumsPackages)) {
        return null;
      }
      var package_hash = _.get(data, 'package_hash');
      var manifest_blob_url = _.get(data, 'manifest_blob_url');
      var blob_url = _.get(data, 'blob_url');
      var workDirectoryPath = path.join(os.tmpdir(), security.randToken(32));
      return _this.downloadPackageAndExtract(workDirectoryPath, package_hash, manifest_blob_url, blob_url).then(function () {
        return Q.allSettled(
          _.map(lastNumsPackages, function (v) {
            return _this.generateOneDiffPackage(workDirectoryPath, packageId, manifest_blob_url, v.package_hash, v.manifest_blob_url);
          })
        );
      });
    })
  });
}

proto.releasePackage = function (deploymentId, packageInfo, fileType, filePath, releaseUid) {
  var _this = this;
  var appVersion = packageInfo.appVersion;
  var description = packageInfo.description;
  var isMandatory = packageInfo.isMandatory;
  return security.qetag(filePath).then(function (blobHash) {
    var directoryPath = path.join(os.tmpdir(), `${blobHash}/new`);
    return common.createEmptyTempFolder(directoryPath).then(function () {
      if (fileType == "application/zip") {
        return common.unzipFile(filePath, directoryPath)
      } else {
        throw new Error("file type error!");
      }
    }).then(function (directoryPath) {
      return _this.calcPackageAllFiles(directoryPath).then(function (data) {
        var packageHash = security.packageHashSync(data);
        var hashFile = directoryPath + "/../hashFile.json";
        fs.writeFileSync(hashFile, JSON.stringify(data));
        return security.qetag(hashFile).then(function (manifestHash) {
          return _this.existPackageHash(deploymentId, appVersion, packageHash).then(function (isExist) {
            if (!isExist){
              return Q.allSettled([
                common.uploadFileToQiniu(manifestHash, hashFile),
                common.uploadFileToQiniu(blobHash, filePath)
              ]).spread(function (up1, up2) {
                return [packageHash, manifestHash, blobHash];
              });
            } else {
              throw new Error("The uploaded package is identical to the contents of the specified deployment's current release.");
            }
          });
        });
      });
    }).spread(function (packageHash, manifestHash, blobHash) {
      var stats = fs.statSync(filePath);
      var params = {
        releaseMethod: 'Upload',
        releaseUid: releaseUid,
        isMandatory: isMandatory,
        size: stats.size,
        description: description
      }
      return _this.createPackage(deploymentId, appVersion, packageHash, manifestHash, blobHash, params);
    });
  });
};
