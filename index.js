/*
	Copyright 2014, Marten de Vries

	Licensed under the Apache License, Version 2.0 (the "License");
	you may not use this file except in compliance with the License.
	You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

	Unless required by applicable law or agreed to in writing, software
	distributed under the License is distributed on an "AS IS" BASIS,
	WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	See the License for the specific language governing permissions and
	limitations under the License.
*/

"use strict";

var Promise = require("pouchdb-promise");
var nodify = require("promise-nodify");
var uuid = require("random-uuid-v4");
var Validation = require("pouchdb-validation");
var equals = require("equals");
var extend = require("extend");
var PouchPluginError = require("pouchdb-plugin-error");

//to update: http://localhost:5984/_replicator/_design/_replicator & remove _rev.
var DESIGN_DOC = require("./designdoc.js");

var dbData = {
  dbs: [],
  changesByDbIdx: [],
  activeReplicationsByDbIdxAndId: [],
  activeReplicationSignaturesByDbIdxAndRepId: [],
  changedByReplicatorByDbIdx: [],
};

exports.startReplicator = function (callback) {
  //When the replicator is started:
  //- replication is started for every already existing document in the
  //  database
  //- subscribing 'live' to the changes feed of the database commences
  //  for future updates
  //- strict validation rules (using the pouchdb-validation plug-in
  //  behind the screens) come into effect for the database.
  var db = this;

  try {
    Validation.installValidationMethods.call(db);
  } catch (err) {
    return Promise.reject(new PouchPluginError({
      status: 500,
      name: "already_active",
      message: "Replicator already active on this database."
    }));
  }

  var i = dbData.dbs.push(db) - 1;
  dbData.activeReplicationsByDbIdxAndId[i] = {};
  dbData.activeReplicationSignaturesByDbIdxAndRepId[i] = {};
  dbData.changedByReplicatorByDbIdx[i] = [];

  var promise = db.put(DESIGN_DOC)
    .catch(function () {/*that's fine, probably already there*/})
    .then(function () {
      return db.allDocs({
        include_docs: true
      });
    })
    .then(function (allDocs) {
      //start replication for current docs
      allDocs.rows.forEach(function (row) {
        onChanged(db, row.doc);
      });
    })
    .then(function () {
      //start listening for changes on the replicator db
      var changes = db.changes({
        since: "now",
        live: true,
        returnDocs: false,
        include_docs: true
      });
      changes.on("change", function (change) {
        onChanged(db, change.doc);
      });
      dbData.changesByDbIdx[i] = changes;
    });

  nodify(promise, callback);
  return promise;
};

function onChanged(db, doc) {
  //Stops/starts replication as required by the description in ``doc``.

  var data = dataFor(db);

  var isReplicatorChange = data.changedByReplicator.indexOf(doc._id) !== -1;
  if (isReplicatorChange) {
    data.changedByReplicator.splice(doc._id, 1);
  }
  if (isReplicatorChange || doc._id.indexOf("_design") === 0) {
    //prevent recursion & design docs respectively
    return;
  }
  var currentSignature;
  var docCopy = extend({}, doc);

  //stop an ongoing replication (if one)
  var oldReplication = data.activeReplicationsById[doc._id];
  if (oldReplication) {
    oldReplication.cancel();
  }
  if (doc.replication_id) {
    currentSignature = data.activeReplicationSignaturesByRepId[doc.replication_id];
  }
  //removes the data used to get cancel & currentSignature now it's no
  //longer necessary
  cleanupReplicationData(db, doc);

  if (!doc._deleted) {
    //update doc so it's ready to be replicated (if necessary).
    currentSignature = extend({}, doc);
    delete currentSignature._id;
    delete currentSignature._rev;

    //check if the signatures match ({repId: signature} format). If it
    //does, it's a duplicate replication which means that it just gets
    //the id assigned of the already active replication and nothing else
    //happens.
    var repId = getMatchingSignatureId(db, currentSignature);
    if (repId) {
      doc.replication_id = repId;
    } else {
      doc.replication_id = uuid();
      doc.replication_state = "triggered";
    }
  }
  if (doc.replication_state === "triggered") {
    //(re)start actual replication
    var PouchDB = db.constructor;
    var replication = PouchDB.replicate(doc.source, doc.target, doc);
    data.activeReplicationsById[doc._id] = replication;
    data.activeReplicationSignaturesByRepId[doc.replication_id] = currentSignature;
    replication.on("complete", onReplicationComplete.bind(null, db, doc._id));
    replication.on("error", onReplicationError.bind(null, db, doc._id));
  }

  if (!equals(doc, docCopy)) {
    putAsReplicatorChange(db, doc);
  }
}

function dataFor(db) {
  var dbIdx = dbData.dbs.indexOf(db);
  if (dbIdx === -1) {
    throw new Error("db doesn't exist");
  }
  return {
    changes: dbData.changesByDbIdx[dbIdx],
    activeReplicationsById: dbData.activeReplicationsByDbIdxAndId[dbIdx],
    activeReplicationSignaturesByRepId: dbData.activeReplicationSignaturesByDbIdxAndRepId[dbIdx],
    changedByReplicator: dbData.changedByReplicatorByDbIdx[dbIdx]
  };
}

function cleanupReplicationData(db, doc) {
  //cleanup replication data which is now no longer necessary
  var data = dataFor(db);

  delete data.activeReplicationsById[doc._id];
  delete data.activeReplicationSignaturesByRepId[doc.replication_id];
}

function getMatchingSignatureId(db, searchedSignature) {
  var data = dataFor(db);

  for (var repId in data.activeReplicationSignaturesByRepId) {
    if (data.activeReplicationSignaturesByRepId.hasOwnProperty(repId)) {
      var signature = data.activeReplicationSignaturesByRepId[repId];
      if (equals(signature, searchedSignature)) {
        return repId;
      }
    }
  }
}

function onReplicationComplete(db, docId, info) {
  delete info.status;
  delete info.ok;
  updateExistingDoc(db, docId, function (doc) {
    doc.replication_state = "completed";
    doc.replication_stats = info;
  });
}

function updateExistingDoc(db, docId, func) {
  db.get(docId).then(function (doc) {
    cleanupReplicationData(db, doc);

    func(doc);
    putAsReplicatorChange(db, doc).catch(function (err) {
      if (err.status === 409) {
        updateExistingDoc(db, docId, func);
      } else {
        throw err;
      }
    });
  });
}

function putAsReplicatorChange(db, doc) {
  if (doc.replication_state) {
    doc.replication_state_time = Date.now();
  }

  var data = dataFor(db);
  data.changedByReplicator.push(doc._id);

  return db.put(doc, {
    userCtx: {
      roles: ["_replicator", "_admin"],
    }
  }).catch(function (err) {
    var idx = data.changedByReplicator.indexOf(doc._id);
    data.changedByReplicator.splice(idx, 1);

    throw err;
  });
}

function onReplicationError(db, docId, info) {
  updateExistingDoc(db, docId, function (doc) {
    doc.replication_state = "error";
    doc.replication_state_reason = info.message;
  });
}

exports.stopReplicator = function (callback) {
  //Stops all replications & listening to future changes & relaxes the
  //validation rules for the database again.
  var db = this;
  var data;
  try {
    data = dataFor(db);
  } catch (err) {
    return Promise.reject(new PouchPluginError({
      status: 500,
      name: "already_inactive",
      message: "Replicator already inactive on this database."
    }));
  }
  var index = dbData.dbs.indexOf(db);
  //clean up
  dbData.dbs.splice(index, 1);
  dbData.changesByDbIdx.splice(index, 1);
  dbData.activeReplicationSignaturesByDbIdxAndRepId.splice(index, 1);
  dbData.activeReplicationsByDbIdxAndId.splice(index, 1);
  dbData.changedByReplicatorByDbIdx.splice(index, 1);

  var promise = new Promise(function (resolve, reject) {
    //cancel changes/replications
    var stillCancellingCount = 0;
    function doneCancelling(eventEmitter) {
      //listening is no longer necessary.
      eventEmitter.removeAllListeners();

      stillCancellingCount -= 1;
      if (stillCancellingCount === 0) {
        resolve();
      }
    }
    function cancel(cancelable) {
      cancelable.on("complete", doneCancelling.bind(null, cancelable));
      cancelable.on("error", doneCancelling.bind(null, cancelable));
      process.nextTick(cancelable.cancel.bind(cancelable));
      stillCancellingCount += 1;
    }
    cancel(data.changes);
    data.changes.removeAllListeners("change");

    for (var id in data.activeReplicationsById) {
      if (data.activeReplicationsById.hasOwnProperty(id)) {
        cancel(data.activeReplicationsById[id]);
      }
    }
  }).then(function () {
    //validation - last because startReplicator checks if the replicator
    //is already running by checking if validation is active.
    Validation.uninstallValidationMethods.call(db);
  });

  nodify(promise, callback);
  return promise;
};
