// Copyright 2016 Zipscene, LLC
// Licensed under the Apache License, Version 2.0
// http://www.apache.org/licenses/LICENSE-2.0

const CrispHooks = require('crisphooks');
const { ObjectMask, deepCopy, setPath, getPath, isScalar, merge } = require('objtools');
const _ = require('lodash');
const XError = require('xerror');
const pasync = require('pasync');
const { createQuery, createUpdate, createAggregate, Update } = require('common-query');
const zstreams = require('zstreams');
const Profiler = require('simprof');
const PermissionSet = require('flexperm');

const profiler = new Profiler('ModelAccessWrapper');

/**
 * This is a wrapper around a unimodel model that applies permissions and additional
 * access semantics to the model.
 *
 * @class ModelAccessWrapper
 * @constructor
 * @param {Object} options
 *   @param {UnimodelModel} options.model - The unimodel model
 *   @param {String[]} [options.keys] - An array of field names that are keys to uniquely identify
 *     a document.  If not given, this is derived from `model.getKeys()` which looks
 *     for schema entries with `{ key: true }` set.
 *   @param {Function} options.serialize - A function that converts a unimodel document to a data
 *     object for returning to the user.  It should return a flat data object (or a Promise resolving
 *     with that object).
 *     @param {UnimodelDocument} options.serialize.doc
 *     @param {Object} options.serialize.params
 *   @param {String} [options.permissionsTarget] - The permission target name.  Defaults to the
 *     model name.
 *   @param {Boolean} [options.allowNoPermissions=false] - Whether to allow no permissions
 */
class ModelAccessWrapper extends CrispHooks {

	constructor(options = {}) {
		super();
		this.options = options;
		if (!options.permissionsTarget) {
			options.permissionsTarget = options.model.getName();
		}
		this.model = options.model;
		this.serialize = options.serialize || function(doc) { return deepCopy(doc.getData()); };
		this.keyFields = options.keys || (this.model.getKeys && this.model.getKeys());
		if (!this.keyFields || !this.keyFields.length) {
			throw new XError(XError.INTERNAL_ERROR, 'No key fields could be found');
		}

		// Generate mask to filter out private fields
		this.hasPrivateFields = false;
		this.hasProtectedFields = false;
		this.publicMask = new ObjectMask({ _: true });
		this.privateMask = new ObjectMask({});
		this.protectedMask = new ObjectMask({});
		this.protectedFields = [];
		this.model.schema.traverseSchema({
			onSubschema: (subschema, path) => {
				if (subschema.private) {
					this.privateMask.addField(path);
					this.hasPrivateFields = true;
				}
				if (subschema.protected) {
					this.protectedMask.addField(path);
					this.hasProtectedFields = true;
					this.protectedFields.push(path);
				}
			}
		});
		this.publicPrivateMask = this.publicMask;
		this.publicMask = ObjectMask.subtractMasks(this.publicMask, this.privateMask);

		// Generate 'fake' PermissionSet that checks for private fields. This will be universally called.
		this.globalPermissions = new PermissionSet([ {
			target: 'global',
			match: {},
			grant: {
				global: true,
				readMask: this.publicMask.mask,
				writeMask: this.publicMask.mask
			}
		} ]);
		// Generate new schema that does not include private fields
		this.publicSchema = this.model.schema.filterSchema((subschema) => {
			if (subschema.private === true) return false;
			return null;
		});
	}

	/**
	 * Given a document, converts it into a result object from these functions.
	 *
	 * @method prepareResultObject
	 * @param {UnimodelDocument} doc
	 * @param {Object} params - Whatever params are passed into the respective function
	 * @return {Promise} - Resolves with an object containing: `{ doc, data }` Where `doc` is the
	 *   actual unimodel document, and `data` is the object of processed and filtered data to return
	 *   to the user.
	 */
	prepareResultObject(doc, params = {}) {
		let prof = profiler.begin('#prepareResultObject');
		let prof1 = profiler.begin('#prepareResultObject serialize');
		return Promise.resolve()
			.then(() => {
				// Filter out private fields
				if (!params.allowPrivateFields && this.hasPrivateFields) {
					this.publicSchema.normalize(doc.data, { removeUnknownFields: true, allowMissingFields: true });
				}
			})
			.then(() => this.serialize(doc, params))
			.then(prof1.wrappedEnd())
			.then((data) => {
				if (!data) return null;
				// Filter results by permissions
				if (params.filterPermissionsFunc) {
					let prof2 = profiler.begin('#prepareResultObject filterPermissionsFunc');
					data = params.filterPermissionsFunc(data);
					prof2.end();
					if (!data) throw new XError(XError.ACCESS_DENIED, 'No access to data fields');
				}
				// Filter results by requested fields
				if (params.filterFieldsFunc) {
					let prof3 = profiler.begin('#prepareResultObject filterFieldsFunc');
					data = params.filterFieldsFunc(data);
					prof3.end();
					if (!data) throw new XError(XError.ACCESS_DENIED, 'No access to any requested fields');
				}
				return { data, doc };
			})
			.then(prof.wrappedEnd());
	}

	/**
	 * Appends additional fields to `params` before running any of these functions.
	 * This has the following functions:
	 * - Create a `requestFields` param containingthe union of `fields`, `extraFields`, and
	 *   fields needed by permissions.
	 * - Rename `requestFields` to `fields`, so it can be passed directly into unimodel.
	 * - Rename the original `fields` to `filterFields` (ie, the fields to return in the result).
	 * - Create a `filterFieldsMask` param containing the ObjectMask of `filterFields`.
	 * - Create a `filterFieldsFunc` param as a function that filters an object by `filterFields`.
	 * - Create a `filterPermissionsFunc` param as a function that permission filters an object.
	 *
	 * @method _preprocessParams
	 * @private
	 * @param {Object} params
	 * @param {String} method - 'get', 'put', etc
	 * @return {Object}
	 */
	_preprocessParams(params, method) {
		this.triggerSync('preprocess-params', params, method);

		// Check if permissions are supplied
		if (!params.permissions && !this.options.allowNoPermissions) {
			throw new XError(XError.INVALID_ARGUMENT, 'No permissions supplied');
		}
		// Compute `params.requestFields` if needed
		if (!params.requestFields && params.fields) {
			// Make a combined list of fields needed by the database
			// This combined list includes:
			// Requested fields, Extra requested fields, Fields needed by permissions
			let permissionsFields;
			if (params.permissions) {
				permissionsFields = params.permissions.getTargetQueryFields();
			}
			params.requestFields = _.union(
				params.fields || [],
				params.extraFields || [],
				permissionsFields || []
			);
		}

		// Rename `requestFields`->`fields` and `fields`->`filterFields`
		if (params.fields && !params.filterFields) params.filterFields = params.fields;
		if (params.requestFields) params.fields = params.requestFields;

		// Create a filter function for the fields
		if (params.filterFields && !params.skipFilterFields) {
			let filterFieldsMask = {};
			for (let field of params.filterFields) {
				setPath(filterFieldsMask, field, true);
			}
			params.filterFieldsMask = new ObjectMask(filterFieldsMask);
			params.filterFieldsFunc = params.filterFieldsMask.createFilterFunc();
		}

		// Create a filter function for permissions
		if (params.permissions && !params.skipFilterPermissions) {
			params.filterPermissionsFunc = params.permissions.createFilterByMask(
				this.options.permissionsTarget,
				'read',
				'readMask'
			);
		}

		return params;
	}

	/**
	 * Get a single document.
	 *
	 * @method get
	 * @param {Object} params
	 *   @param {Object} params.keys - The key values to use to fetch the document.  Should be a map
	 *     from field names to values.
	 *   @param {String[]} params.fields - A list of fields to return
	 *   @param {String[]} params.extraFields - A list of fields to fetch from unimodel, but not returned
	 *   @param {String[]} params.requestFields - List of fields to fetch from the db.  If not supplied,
	 *     this is computed by combining `fields`, `extraFields`, and whatever is needed by permissions.
	 *   @param {Boolean} params.skipFilterFields - Do not filter result by the provided fields. Usually set
	 *     by the preprocess-params hook.
	 *   @param {PermissionSet} params.permissions - Permissions of the user
	 *   @param {Boolean} params.skipFilterPermissions - Do not filter result by permissions. Usually set
	 *     by the preprocess-params hook.
	 *   @param {Boolean} params.allowPrivateFields - Allow queries / updates on private fields, and do not
	 *     filter private fields from result documents.
	 * @return {Promise{Object}} - Promise resolving to an object containing `doc` which
	 *   is an instance of UnimodelDocument, and `data`, which is the data to return.
	 */
	get(params) {
		return Promise.resolve()
			.then(() => {
				let prof = profiler.begin('#get');

				this._preprocessParams(params, 'get');
				let model = this.model;
				let keys = params.keys || {};
				for (let field in keys) {
					if (!_.includes(this.keyFields, field)) {
						throw new XError(XError.INVALID_ARGUMENT, `${field} is not a document key`);
					}
					if (!isScalar(keys[field]) || _.isNil(keys[field])) {
						throw new XError(XError.INVALID_ARGUMENT, `${field} key must be a scalar`);
					}
				}
				for (let field of this.keyFields) {
					if (keys[field] === undefined) {
						throw new XError(XError.INVALID_ARGUMENT, `Missing document key ${field}`);
					}
				}
				return Promise.resolve()
					.then(() => this.trigger('pre-get', params))
					.then(() => model.findOne(keys, params))
					.then((doc) => this.prepareResultObject(doc, params))
					.then(prof.wrappedEnd());
			});
	}

	/**
	 * Query a set of documents.
	 *
	 * @method query
	 * @param {Object} params
	 *   @param {Object} params.query
	 *   @param {String[]} params.fields
	 *   @param {String[]} params.sort
	 *   @param {Number} params.skip
	 *   @param {Number} params.limit
	 *   @param {Boolean} params.allowPrivateFields
	 * @return {Promise} - Promise resolving with array of objects containing `{ doc, data }`
	 */
	query(params) {
		let prof = profiler.begin('#query');

		let model = this.model;
		return Promise.resolve()
			.then(() => this._preprocessParams(params, 'query'))
			.then(() => this.trigger('pre-query', params))
			.then(() => {
				if (params.permissions) {
					params.permissions.checkExecuteQuery(
						this.options.permissionsTarget,
						params.query,
						params,
						'query'
					);
				}
			})
			.then(() => {
				if (!params.allowPrivateFields && this.hasPrivateFields) {
					this.globalPermissions.checkExecuteQuery(
						'global',
						params.query,
						params,
						'global'
					);
				}
			})
			.then(() => model.find(params.query, params))
			.then((docs) => {
				let numFilteredDocs = 0;
				return pasync.mapSeries(docs, (doc) => {
					return this.prepareResultObject(doc, params)
						.catch((err) => {
							if (err && err.code === XError.ACCESS_DENIED) {
								numFilteredDocs++;
								return null;
							} else {
								throw err;
							}
						});
				})
					.then((results) => {
						if (numFilteredDocs >= docs.length && docs.length) {
							throw new XError(XError.ACCESS_DENIED, 'All results filtered.');
						}
						return results;
					});
			})
			.then(prof.wrappedEnd());
	}

	/**
	 * Query a set of documents, returning a stream of results.
	 *
	 * @method stream
	 * @param {Object} params
	 *   @param {Object} params.query
	 *   @param {String[]} params.fields
	 *   @param {String[]} params.sort
	 *   @param {Number} params.skip
	 *   @param {Number} params.limit
	 *   @param {Boolean} params.allowPrivateFields
	 * @return {Promise{Readable}} - Promise resolves with a Readable object stream.
	 *   The stream contains objects like `{ doc, data }` .
	 */
	stream(params) {
		let prof = profiler.begin('#stream');

		let model = this.model;
		return Promise.resolve()
			.then(() => this._preprocessParams(params, 'stream'))
			.then(() => this.trigger('pre-query', params))
			.then(() => {
				if (params.permissions) {
					params.permissions.checkExecuteQuery(
						this.options.permissionsTarget,
						params.query,
						params,
						'query'
					);
				}
			})
			.then(() => {
				if (!params.allowPrivateFields && this.hasPrivateFields) {
					this.globalPermissions.checkExecuteQuery(
						'global',
						params.query,
						params,
						'global'
					);
				}
			})
			.then(() => zstreams(model.findStream(params.query, params)))
			.then((stream) => {
				return stream.through((doc) => {
					if (!doc) return null;

					let prof1 = profiler.begin('#stream prepareResultObject');
					return this.prepareResultObject(doc, params)
						.catch((err) => {
							if (err && err.code === XError.ACCESS_DENIED) {
								return null;
							} else {
								throw err;
							}
						})
						.then(prof1.wrappedEnd());
				});
			})
			.then(prof.wrappedEnd());
	}

	/**
	 * Returns a count of matching documents after checking permissions.
	 *
	 * @method count
	 * @param {Object} params
	 *   @param {Object} params.query
	 *   @param {PermissionSet} params.permissions
	 *   @param {Boolean} params.allowPrivateFields
	 * @return {Promise{Number}} - Resolves with number of matching documents
	 */
	count(params) {
		let prof = profiler.begin('#count');

		let model = this.model;
		return Promise.resolve()
			.then(() => this._preprocessParams(params, 'count'))
			.then(() => this.trigger('pre-count', params))
			.then(() => {
				if (params.permissions) {
					params.permissions.checkExecuteQuery(
						this.options.permissionsTarget,
						params.query,
						params,
						'count'
					);
				}
			})
			.then(() => {
				if (!params.allowPrivateFields && this.hasPrivateFields) {
					this.globalPermissions.checkExecuteQuery(
						'global',
						params.query,
						params,
						'global'
					);
				}
			})
			.then(() => model.count(params.query, params))
			.then(prof.wrappedEnd());
	}

	/**
	 * Run aggregates after checking permissions.
	 *
	 * @method aggregateMulti
	 * @param {Object} params
	 *   @param {Object} params.query
	 *   @param {Object} params.aggregates - Map from aggregate name to aggregate spec
	 *   @param {Number} params.limit
	 *   @param {Number} params.scanLimit
	 *   @param {Boolean} params.allowPrivateFields
	 * @return {Object} - Map from aggregate name to results
	 */
	aggregateMulti(params) {
		let prof = profiler.begin('#aggregateMulti');

		let model = this.model;
		let query, aggregates;
		return Promise.resolve()
			.then(() => this._preprocessParams(params, 'aggregateMulti'))
			.then(() => this.trigger('pre-aggregate', params))
			.then(() => {
				query = createQuery(params.query, {
					schema: model.getSchema && model.getSchema()
				});

				if (params.permissions) {
					// Check query permissions
					params.permissions.checkExecuteQuery(
						this.options.permissionsTarget,
						params.query,
						params,
						[ 'query', 'aggregate' ]
					);
				}

				if (this.hasPrivateFields && !params.allowPrivateFields) {
					this.globalPermissions.checkExecuteQuery(
						'global',
						params.query,
						params,
						'global'
					);
				}

				// Convert and normalize aggregates
				aggregates = _.mapValues(
					params.aggregates,
					(aggrObj) => createAggregate(aggrObj, { schema: model.getSchema && model.getSchema() })
				);

				// Get list of fields accessed by the aggregate
				let aggregateAccessedFields = _.map(
					_.values(aggregates),
					(aggr) => aggr.getQueriedFields({ schema: model.getSchema && model.getSchema() })
				);
				let accessedFields;
				if (aggregateAccessedFields.length === 1) {
					accessedFields = aggregateAccessedFields[0];
				} else {
					accessedFields = _.union(...aggregateAccessedFields);
				}

				if (params.permissions) {
					// Get the permissions grant that applies to the objects being queried
					let grant = params.permissions.getTargetGrant(
						this.options.permissionsTarget,
						query.getExactMatches().exactMatches
					);

					// Ensure they have access to aggregate or read each of the fields requested
					for (let field of accessedFields) {
						try {
							grant.check(field, 'readMask.');
						} catch (ex) {
							if (ex && ex.code === XError.ACCESS_DENIED) {
								grant.check(field, 'aggregateMask.');
							} else {
								throw ex;
							}
						}
					}
				}

				// Run the aggregate
				return model.aggregateMulti(
					query,
					aggregates,
					params
				);
			})
			.catch((error) => {
				throw error;
			})
			.then(prof.wrappedEnd());
	}

	/**
	 * Inserts/replaces a document in the database.
	 *
	 * @method put
	 * @param {Object} params
	 *   @param {Object} params.data
	 *   @param {PermissionSet} params.permissions
	 *   @param {Boolean} params.allowPrivateFields
	 * @return {Promise} - Resolves with `{ keys: { id: ID_OF_INSERTED_OBJECT } }`
	 */
	put(params) {
		let prof = profiler.begin('#put');

		let data;
		let model = this.model;
		let keys;
		return Promise.resolve()
			.then(() => this._preprocessParams(params, 'put'))
			.then(() => this.trigger('pre-put', params))
			.then(() => {
				data = params.data;

				// Remove protected fields from data
				if (this.hasProtectedFields && !params.overwriteProtected) {
					data = ObjectMask.subtractMasks(this.publicPrivateMask, this.protectedMask).filterObject(data);
				}

				// Check global permissions
				if (this.hasPrivateFields && !params.allowPrivateFields) {
					this.globalPermissions.getTargetGrant('global', data).checkMask('writeMask', data);
				}

				// Get the keys of the object to form the query to find the current document
				keys = {};
				for (let field of this.keyFields) {
					let value = getPath(data, field);
					if (value === undefined || value === null) {
						throw new XError(XError.INVALID_ARGUMENT, 'Missing document key ' + field);
					}
					if (!isScalar(value)) {
						throw new XError(XError.INVALID_ARGUMENT, field + ' key must be a scalar');
					}
					keys[field] = value;
				}

				// Perform the update
				return this.model.findOne(keys)
					.then((doc) => {
						if (params.permissions) {
							this._checkDiffPermissions(params.permissions, doc, data, params.overwriteProtected);
						}

						// Make the update
						// Unless we're private-field-aware, copy existing private fields onto the update to
						// preserve them through the update
						if (this.hasPrivateFields && !params.allowPrivateFields) {
							const existingPrivateFields = this.privateMask.filterObject(doc.data);
							merge(data, existingPrivateFields || {});
						}
						// Unless we're protected-field-aware, copy existing protected fields onto the update to
						// preserve them through the update
						if (this.hasProtectedFields && !params.overwriteProtected) {
							const existingProtectedFields = this.protectedMask.filterObject(doc.data);
							merge(data, existingProtectedFields || {});
						}
						let update = createUpdate(data, {
							allowFullReplace: true,
							schema: model.getSchema && model.getSchema()
						});
						if (!update.isFullReplace()) {
							throw new XError(XError.INVALID_ARGUMENT, 'put() cannot use update operators');
						}
						update.apply(doc.getData(), { allowFullReplace: true });
						return doc;
					})
					.catch((err) => {
						if (err.code !== XError.NOT_FOUND) throw err;

						if (params.permissions) {
							this._checkDiffPermissions(
								params.permissions,
								model.create(),
								data,
								params.overwriteProtected
							);
						}
						return model.create(data);
					})
					.then((doc) => doc.save());
			})
			.then((result) => {
				if (result && result.data) {
					// Pull the keys out of the returned object
					keys = {};
					for (let field of this.keyFields) {
						let value = getPath(result.data, field);
						keys[field] = value;
					}
				}
				return { keys };
			})
			.then(prof.wrappedEnd());
	}

	/**
	 * Tests permissions against an update from a specified document to the passed data.
	 *
	 * If specified document is an existing one, this checks changed fields.
	 * If specified document is a new, empty one, this allows creating documents
	 * when the user does not have permissions for defaulted fields.
	 *
	 * @method _checkDiffPermissions
	 * @private
	 * @throws XError.ACCESS_DENIED
	 * @param {PermissionSet} permissions - Permission set to test against
	 * @param {UnimodelDocument} doc - Initial document to create diff from
	 * @param {Object} data - Changed data to diff against `doc`
	 * @param {Boolean} [overwriteProtected=false] - Whether to attempt to overwrite protected properties.
	 */
	_checkDiffPermissions(permissions, doc, data, overwriteProtected = false) {
		const grant = permissions.getTargetGrant(this.options.permissionsTarget, data);
		const patch = Update.createFromDiff(doc.data, data);

		let fields = createUpdate(patch).getUpdatedFields();
		fields = _.pull(fields, '_id');

		// Skip permissions checks on protected fields, as they should not exist
		if (overwriteProtected) {
			grant.check('overwriteProtected');
		} else if (this.hasProtectedFields) {
			// Make sure protected fields have been stripped out from the target doc by this point
			if (this.protectedFields.some((field) => getPath(data, field) !== undefined)) {
				throw new XError(XError.INVALID_ARGUMENT, 'Target document contains protected fields.');
			}
			fields = _.pullAll(fields, this.protectedFields);
		}

		grant.check('write');
		grant.check(fields, 'writeMask.');
	}

	/**
	 * Updates existing documents, inserting one if it doesn't exist.
	 *
	 * @method update
	 * @param {Object} params
	 *   @param {Object} params.query
	 *   @param {Object} params.update
	 *   @param {PermissionSet} params.permissions
	 *   @param {Boolean} params.allowPrivateFields
	 * @return {Promise}
	 */
	upsert(params) {
		let prof = profiler.begin('#upsert');

		let model = this.model;
		return Promise.resolve()
			.then(() => this._preprocessParams(params, 'upsert'))
			.then(() => this.trigger('pre-upsert', params))
			.then(() => {
				// Make the query
				const query = createQuery(params.query, {
					schema: model.getSchema && model.getSchema()
				});
				// Make the update
				const update = createUpdate(params.update, {
					allowFullReplace: false,
					schema: model.getSchema && model.getSchema()
				});
				const updatedFields = update.getUpdatedFields();

				if (this.hasProtectedFields && !params.overwriteProtected) {
					const containsProtected = this.protectedFields.some((field) => _.includes(updatedFields, field));
					if (containsProtected) {
						throw new XError(XError.INVALID_ARGUMENT, 'Target document contains protected fields.');
					}
				}

				// Check permissions
				if (params.permissions) {
					// Make sure they can execute the query
					params.permissions.checkExecuteQuery(
						this.options.permissionsTarget,
						query,
						params,
						'query'
					);

					if (this.hasPrivateFields && !params.allowPrivateFields) {
						this.globalPermissions.checkExecuteQuery(
							'global',
							query,
							params,
							'global'
						);
					}

					// Use the query's exact matches to find the grant to apply
					let { exactMatches } = query.getExactMatches();
					let exactMatchObj = {};
					for (let field in exactMatches) {
						setPath(exactMatchObj, field, exactMatches[field]);
					}
					let grant = params.permissions.getTargetGrant(this.options.permissionsTarget, exactMatchObj);

					if (params.overwriteProtected) grant.check('overwriteProtected');

					// Check against global write permissions
					if (this.hasPrivateFields && !params.allowPrivateFields) {
						this.globalPermissions.getTargetGrant('global', exactMatchObj)
							.check(exactMatches, 'writeMask.');
					}
					// Make sure write permission is granted for both the query exact match fields
					// and any updated fields, because the query exact match fields can be written
					// to if it's an insert.
					try {
						let fields = _.union(_.keys(exactMatches), update.getUpdatedFields());
						grant.check('write');
						grant.check(fields, 'writeMask.');
					} catch (ex) {
						if (ex.code === XError.ACCESS_DENIED) {
							// Access denied trying to update all generic documents that could be
							// matched by the query.  The user may still have permissions on
							// individual documents, so try to manually loop over them.
							return this._upsertLoop(query, update, params.permissions, params);
						} else {
							throw ex;
						}
					}
				}

				// Perform the update
				return model.upsert(query, update, params);
			})
			.then(prof.wrappedEnd());
	}

	/**
	 * Manually performs an upsert by doing a count(), then streaming query results for the update.
	 * This is used when the user doesn't have permissions for every object that may match their
	 * query, but might have permissions for objects that *actually* match.  This is slower than
	 * the database method.
	 */
	_upsertLoop(query, update, permissions, params) {
		let updatedFields = update.getUpdatedFields();
		return this.model.findOne(query, params)
			.then(() => {
				// At least one document exists.  Iterate through them and apply the update.
				return this.model.findStream(query, params).each((doc) => {
					let grant = permissions.getTargetGrant(this.options.permissionsTarget, doc.getData());
					grant.check('write');
					grant.check(updatedFields, 'writeMask.');
					update.apply(doc.getData());
					return doc.save();
				}).intoPromise();
			}, (err) => {
				if (err.code !== XError.NOT_FOUND) throw err;
				// A document like this doesn't exist yet.  Construct one and insert it.
				let dataToInsert = {};
				let { exactMatches } = query.getExactMatches();
				for (let key in exactMatches) {
					setPath(dataToInsert, key, exactMatches[key]);
				}
				update.apply(dataToInsert);
				let grant = permissions.getTargetGrant(this.options.permissionsTarget, dataToInsert);
				grant.check('write');
				grant.check(updatedFields, 'writeMask.');
				let doc = this.model.create(dataToInsert);
				return doc.save();
			});
	}

	/**
	 * Updates existing documents.
	 *
	 * @method update
	 * @param {Object} params
	 *   @param {Object} params.query
	 *   @param {Object} params.update
	 *   @param {PermissionSet} params.permissions
	 *   @param {Boolean} params.allowPrivateFields
	 * @return {Promise}
	 */
	update(params) {
		let prof = profiler.begin('#update');

		let model = this.model;
		return Promise.resolve()
			.then(() => this._preprocessParams(params, 'update'))
			.then(() => this.trigger('pre-update', params))
			.then(() => {
				const query = createQuery(params.query, {
					schema: model.getSchema && model.getSchema()
				});
				const update = createUpdate(params.update, {
					allowFullReplace: false,
					schema: model.getSchema && model.getSchema()
				});
				const updatedFields = update.getUpdatedFields();

				if (this.hasProtectedFields && !params.overwriteProtected) {
					const containsProtected = this.protectedFields.some((field) => _.includes(updatedFields, field));
					if (containsProtected) {
						throw new XError(XError.INVALID_ARGUMENT, 'Target document contains protected fields.');
					}
				}

				if (params.permissions) {
					// Make sure they can execute the query
					params.permissions.checkExecuteQuery(
						this.options.permissionsTarget,
						query,
						params,
						'query'
					);

					if (this.hasPrivateFields && !params.allowPrivateFields) {
						this.globalPermissions.checkExecuteQuery(
							'global',
							query,
							params,
							'global'
						);
					}

					// Use the query's exact matches to find the grant to apply
					let { exactMatches } = query.getExactMatches();
					let exactMatchObj = {};
					for (let field in exactMatches) {
						setPath(exactMatchObj, field, exactMatches[field]);
					}
					let grant = params.permissions.getTargetGrant(
						this.options.permissionsTarget,
						exactMatchObj
					);

					if (params.overwriteProtected) grant.check('overwriteProtected');

					try {
						// Make sure write permission is granted
						grant.check('write');
						grant.check(updatedFields, 'writeMask.');
						// Check global write permission
						if (this.hasPrivateFields && !params.allowPrivateFields) {
							this.globalPermissions.getTargetGrant('global', exactMatchObj)
								.check(exactMatches, 'writeMask.');
						}
					} catch (ex) {
						if (ex.code === XError.ACCESS_DENIED) {
							// Access denied trying to update all generic documents that could be
							// matched by the query.  The user may still have permissions on
							// individual documents, so try to manually loop over them.
							return this._updateLoop(query, update, params.permissions, params);
						} else {
							throw ex;
						}
					}
				}

				return model.update(query, update, params);
			})
			.then(prof.wrappedEnd());
	}

	_updateLoop(query, update, permissions, params) {
		let updatedFields = update.getUpdatedFields();
		// Iterate through documents and apply the update
		return this.model.findStream(query, params).each((doc) => {
			let grant = permissions.getTargetGrant(this.options.permissionsTarget, doc.getData());
			grant.check('write');
			grant.check(updatedFields, 'writeMask.');
			update.apply(doc.getData());
			return doc.save();
		}).intoPromise();
	}

	/**
	 * Remove one or more documents.
	 *
	 * @method remove
	 * @param {Object} params
	 *   @param {Object} params.query
	 *   @param {PermissionSet} params.permissions
	 *   @param {Boolean} params.allowPrivateFields
	 * @return {Promise}
	 */
	remove(params) {
		let prof = profiler.begin('#remove');

		let model = this.model;
		let query;
		return Promise.resolve()
			.then(() => this._preprocessParams(params, 'remove'))
			.then(() => this.trigger('pre-remove', params))
			.then(() => {
				query = createQuery(params.query, {
					schema: model.getSchema && model.getSchema()
				});
				if (params.permissions) {
					// Make sure they can execute the query
					params.permissions.checkExecuteQuery(
						this.options.permissionsTarget,
						query,
						params,
						'query'
					);

					if (!params.allowPrivateFields && this.hasPrivateFields) {
						this.globalPermissions.checkExecuteQuery(
							'global',
							query,
							params,
							'global'
						);
					}

					try {
						// Use the query's exact matches to find the grant to apply
						let { exactMatches } = query.getExactMatches();
						let exactMatchObj = {};
						for (let field in exactMatches) {
							setPath(exactMatchObj, field, exactMatches[field]);
						}
						let grant = params.permissions.getTargetGrant(
							this.options.permissionsTarget,
							exactMatchObj
						);

						// Make sure delete permission is granted
						grant.check('delete');
					} catch (ex) {
						if (ex.code === XError.ACCESS_DENIED) {
							// Access denied trying to remove all generic documents that could be
							// matched by the query.  The user may still have permissions on
							// individual documents, so try to manually loop over them.
							return this._removeLoop(query, params.permissions, params);
						} else {
							throw ex;
						}
					}
				}

				return model.remove(query, params);
			})
			.then(prof.wrappedEnd());
	}

	_removeLoop(query, permissions, params) {
		// Iterate through documents and remove them
		return this.model.findStream(query, params).each((doc) => {
			let grant = permissions.getTargetGrant(this.options.permissionsTarget, doc.getData());
			grant.check('delete');
			return doc.remove();
		}).intoPromise();
	}

}

module.exports = ModelAccessWrapper;
