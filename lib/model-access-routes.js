const decamelize = require('decamelize');
const { defaultSchemaFactory, createSchema, FieldError } = require('zs-common-schema');
const { registerTypes } = require('zs-model-schema-types');
const _ = require('lodash');
const objtools = require('zs-objtools');
const XError = require('xerror');
const pasync = require('pasync');

// Register additional needed schema types
registerTypes(defaultSchemaFactory);

/**
 * Class that registers routes for accessing unimodel models.
 *
 * @class ModelAccessRoutes
 * @constructor
 * @param {ModelAccessWrapper} modelAccessWrapper
 * @param {APIRouter} apiRouter
 * @param {Object} options
 *   @param {String} [options.routePrefix] - The prefix for the routes to register.  A prefix
 *     of 'animal-type' will result in routes like 'animal-type.get'.  This defaults to using
 *     a decamelized and hyphenated verison of `model.getName()` .
 *   @param {Function[]} [options.extraMiddleware] - Extra middleware to execute for each route.
 *     For example, authentication middleware.  Note that authentication middleware is expected
 *     to create `ctx.auth.permissions`.
 *   @param {Object} [options.extraParams] - Extra parameters that can be supplied by the API and
 *     should be passed through to unimodel.  This in in the form of a common-schema object that
 *     gets merged in with the normal route schema.
 */
class ModelAccessRoutes {

	constructor(modelAccessWrapper, apiRouter, options = {}) {
		this.modelAccess = modelAccessWrapper;
		this.apiRouter = apiRouter;
		this.model = this.modelAccess.model;
		if (!options.routePrefix) {
			options.routePrefix = decamelize(this.model.getName(), '-');
		}
		this.options = options;
	}

	/**
	 * Register all API calls for the model.
	 *
	 * @method register
	 * @param {String[]} [except] - Array of API calls not to register.  Ie, `[ 'get' ]`
	 * @param {Object} [callOptions] - Map from call names to options specific to that call
	 */
	register(except = [], callOptions = {}) {
		if (!_.includes(except, 'get')) this.registerGet(callOptions.get);
		if (!_.includes(except, 'query')) this.registerQuery(callOptions.query);
		if (!_.includes(except, 'export')) this.registerExport(callOptions.export);
		if (!_.includes(except, 'count')) this.registerCount(callOptions.count);
		if (!_.includes(except, 'aggregate')) this.registerAggregate(callOptions.aggregate);
		if (!_.includes(except, 'put')) this.registerPut(callOptions.put);
		if (!_.includes(except, 'update')) this.registerUpdate(callOptions.update);
		if (!_.includes(except, 'delete')) this.registerDelete(callOptions.delete);
	}

	_makeParams(params, ctx, options = {}) {
		if (ctx.auth && ctx.auth.permissions) {
			params.permissions = ctx.auth.permissions;
		} else {
			throw new XError(XError.INTERNAL_ERROR, 'No permissions supplied on context');
		}
		for (let extraParam in (options.extraParams || {})) {
			if (ctx.params[extraParam] !== undefined) {
				params[extraParam] = ctx.params[extraParam];
			}
		}
		return params;
	}

	/**
	 * Registers a route to get a single object.
	 *
	 * @method registerGet
	 * @param {Object} [options] - Any of the options supplied to the constructor, but used just for
	 *   this API call.
	 */
	registerGet(options = {}) {
		_.defaults(options, this.options);

		// Create the schema for data keys
		let keyFields = this.model.getKeys();
		let keysSchema = {};
		for (let field of keyFields) {
			let keySubschema = this.model.getSchema().getSubschemaData(field);
			keySubschema = objtools.deepCopy(keySubschema);
			keySubschema.required = true;
			if (keySubschema) {
				objtools.setPath(keysSchema, field, keySubschema);
			} else {
				throw new XError(XError.INTERNAL_ERROR, `Could not find subschema for key field ${field}`);
			}
		}

		// Register the route
		this.apiRouter.register({
			method: options.routePrefix + '.get',
			description: 'Get a single ' + this.model.getName(),
			schema: createSchema(objtools.merge({
				keys: {
					type: 'object',
					properties: keysSchema,
					description: 'Keys that uniquely identify the document to get',
					required: true
				},
				fields: {
					type: [ String ],
					description: 'List of fields to return',
					validate(value) {
						if (value.length === 0) {
							throw new FieldError('invalid', 'fields param must not be empty');
						}
					}
				}
			}, options.extraParams || {}))
		},
		...(options.extraMiddleware),
		(ctx) => {
			let keys = ctx.params.keys;
			return this.modelAccess.get(this._makeParams({
				keys,
				fields: ctx.params.fields,
				extraFields: options.extraFields
			}, ctx, options))
				.then((result) => { return { result: result.data }; });
		});
	}

	/**
	 * Registers a route to query objects.
	 *
	 * @method registerQuery
	 * @param {Object} [options] - Any of the options supplied to the constructor, but used just for
	 *   this API call.
	 */
	registerQuery(options = {}) {
		_.defaults(options, this.options);
		this.apiRouter.register({
			method: options.routePrefix + '.query',
			description: 'Query for ' + this.model.getName() + 's',
			schema: createSchema(objtools.merge({
				query: {
					type: 'documentQuery',
					modelName: this.model.getName(),
					modelType: this.model.getType(),
					documentSchema: this.model.getSchema(),
					required: true,
					description: 'The mongo-style query to execute'
				},
				fields: {
					type: [ String ],
					description: 'List of field names to return',
					validate(value) {
						if (value.length === 0) {
							throw new FieldError('invalid', 'fields param must not be empty');
						}
					}
				},
				sort: {
					type: [ String ],
					description: 'List of field names to sort by'
				},
				skip: {
					type: Number,
					description: 'Number of documents at the head of the list to skip'
				},
				limit: {
					type: Number,
					description: 'Maximum number of documents to return',
					min: 1,
					max: 1000,
					default: 100
				}
			}, options.extraParams || {}))
		},
		...(this.options.extraMiddleware),
		(ctx) => {
			return this.modelAccess.query(this._makeParams({
				query: ctx.params.query,
				fields: ctx.params.fields,
				extraFields: options.extraFields,
				sort: ctx.params.sort,
				skip: ctx.params.skip,
				limit: ctx.params.limit
			}, ctx, options))
				.then((results) => { return { results: _.map(results, 'data') }; });
		});
	}

	/**
	 * Registers a route to query objects in a stream.
	 *
	 * @method registerExport
	 * @param {Object} [options] - Any of the options supplied to the constructor, but used just for
	 *   this API call.
	 */
	registerExport(options = {}) {
		_.defaults(options, this.options);
		this.apiRouter.register({
			method: options.routePrefix + '.export',
			description: 'Export ' + this.model.getName() + 's',
			manualResponse: true,
			schema: createSchema(objtools.merge({
				query: {
					type: 'documentQuery',
					modelName: this.model.getName(),
					modelType: this.model.getType(),
					documentSchema: this.model.getSchema(),
					required: true,
					description: 'The mongo-style query to execute'
				},
				fields: {
					type: [ String ],
					description: 'List of field names to return',
					validate(value) {
						if (value.length === 0) {
							throw new FieldError('invalid', 'fields param must not be empty');
						}
					}
				},
				sort: {
					type: [ String ],
					description: 'List of field names to sort by'
				}
			}, options.extraParams || {}))
		},
		...(this.options.extraMiddleware),
		(ctx) => {
			let sourceDataStream;

			ctx.res.writeHead(200, {
				'Content-type': 'text/plain'
			});

			let sentFinalResult = false;
			let sendFinalResult = (err) => {
				let dataObj;
				if (sentFinalResult) return;
				sentFinalResult = true;
				if (sourceDataStream) {
					sourceDataStream.unpipe();
				}
				if (err) {
					dataObj = { success: false, error: { code: err.code, message: err.message } };
				} else {
					dataObj = { success: true };
				}
				ctx.res.end(
					JSON.stringify(dataObj) + '\n',
					'utf8'
				);
			};

			this.modelAccess.stream(this._makeParams({
				query: ctx.params.query,
				fields: ctx.params.fields,
				extraFields: options.extraFields,
				sort: ctx.params.sort,
				skip: ctx.params.skip,
				limit: ctx.params.limit
			}, ctx, options))
				.then((stream) => {
					sourceDataStream = stream
						.throughData((entry) => {
							let { data } = entry;
							let dataObj = { data };
							let json = JSON.stringify(dataObj) + '\n';
							return new Buffer(json, 'utf8');
						});
					sourceDataStream.on('end', () => sendFinalResult());
					sourceDataStream.on('chainerror', (err) => sendFinalResult(err));
					sourceDataStream.pipe(ctx.res, { end: false });
				})
				.catch((err) => {
					sendFinalResult(err);
				})
				.catch(pasync.abort);
		});
	}

	/**
	 * Registers a route to count objects.
	 *
	 * @method registerCount
	 * @param {Object} [options] - Any of the options supplied to the constructor, but used just for
	 *   this API call.
	 */
	registerCount(options = {}) {
		_.defaults(options, this.options);
		this.apiRouter.register({
			method: options.routePrefix + '.count',
			description: 'Count of ' + this.model.getName() + 's',
			schema: createSchema(objtools.merge({
				query: {
					type: 'documentQuery',
					modelName: this.model.getName(),
					modelType: this.model.getType(),
					documentSchema: this.model.getSchema(),
					required: true,
					description: 'The mongo-style query to execute'
				}
			}, options.extraParams || {}))
		},
		...(this.options.extraMiddleware),
		(ctx) => {
			return this.modelAccess.count(this._makeParams({
				query: ctx.params.query
			}, ctx, options))
				.then((count) => { return { result: count }; });
		});
	}


	/**
	 * Registers a route to aggregate objects.
	 *
	 * @method registerAggregate
	 * @param {Object} [options] - Any of the options supplied to the constructor, but used just for
	 *   this API call.
	 */
	registerAggregate(options = {}) {
		_.defaults(options, this.options);
		this.apiRouter.register({
			method: options.routePrefix + '.aggregate',
			description: 'Aggregate ' + this.model.getName() + 's',
			schema: createSchema(objtools.merge({
				query: {
					type: 'documentQuery',
					modelName: this.model.getName(),
					modelType: this.model.getType(),
					documentSchema: this.model.getSchema(),
					required: true,
					description: 'The mongo-style query to execute'
				},
				aggregates: {
					type: 'map',
					values: {
						type: 'documentAggregate',
						modelName: this.model.getName(),
						modelType: this.model.getType(),
						documentSchema: this.model.getSchema(),
						description: 'The aggregate spec'
					},
					required: true,
					description: 'Map from aggregate keys/names to aggregate specs'
				},
				sort: {
					type: [ String ],
					description: 'List of field names to sort by'
				},
				limit: {
					type: Number,
					description: 'Maximum number of documents to return',
					min: 1,
					max: 10000,
					default: 100
				},
				scanLimit: {
					type: Number,
					description: 'Maximum number of documents to scan while calculating the aggregate'
				}
			}, options.extraParams || {}))
		},
		...(this.options.extraMiddleware),
		(ctx) => {
			return this.modelAccess.aggregateMulti(this._makeParams({
				query: ctx.params.query,
				aggregates: ctx.params.aggregates,
				sort: ctx.params.sort,
				limit: ctx.params.limit,
				scanLimit: ctx.params.scanLimit
			}, ctx, options))
				.then((results) => { return { results }; });
		});
	}


	/**
	 * Registers a route to put objects.
	 *
	 * @method registerPut
	 * @param {Object} [options] - Any of the options supplied to the constructor, but used just for
	 *   this API call.
	 *  @param {Object} [options.documentSchema] - optional cast document schema for the route
	 */
	registerPut(options = {}) {
		_.defaults(options, this.options);
		this.apiRouter.register({
			method: options.routePrefix + '.put',
			description: 'Put ' + this.model.getName() + 's',
			schema: createSchema(objtools.merge({
				data: {
					type: 'document',
					modelName: this.model.getName(),
					modelType: this.model.getType(),
					documentSchema: options.documentSchema || this.model.getSchema(),
					required: true,
					description: 'Data to insert'
				}
			}, options.extraParams || {}))
		},
		...(this.options.extraMiddleware),
		(ctx) => {
			return this.modelAccess.put(this._makeParams({
				data: ctx.params.data
			}, ctx, options))
				.then((result) => {
					return {
						success: true,
						keys: result.keys
					};
				});
		});
	}


	/**
	 * Registers a route to update objects.
	 *
	 * @method registerUpdate
	 * @param {Object} [options] - Any of the options supplied to the constructor, but used just for
	 *   this API call.
	 */
	registerUpdate(options = {}) {
		_.defaults(options, this.options);
		this.apiRouter.register({
			method: options.routePrefix + '.update',
			description: 'Update ' + this.model.getName() + 's',
			schema: createSchema(objtools.merge({
				query: {
					type: 'documentQuery',
					modelName: this.model.getName(),
					modelType: this.model.getType(),
					documentSchema: this.model.getSchema(),
					required: true,
					description: 'The mongo-style query to execute'
				},
				update: {
					type: 'documentUpdate',
					modelName: this.model.getName(),
					modelType: this.model.getType(),
					documentSchema: this.model.getSchema(),
					required: true,
					description: 'Update expression'
				},
				upsert: {
					type: Boolean,
					default: false,
					description: 'If set to true, inserts a new document if none match the query'
				}
			}, options.extraParams || {}))
		},
		...(this.options.extraMiddleware),
		(ctx) => {
			if (ctx.params.upsert) {
				return this.modelAccess.upsert(this._makeParams({
					query: ctx.params.query,
					update: ctx.params.update
				}, ctx, options))
					.then(() => { return { success: true }; });
			} else {
				return this.modelAccess.update(this._makeParams({
					query: ctx.params.query,
					update: ctx.params.update
				}, ctx, options))
					.then(() => { return { success: true }; });
			}
		});
	}


	/**
	 * Registers a route to delete objects.
	 *
	 * @method registerDelete
	 * @param {Object} [options] - Any of the options supplied to the constructor, but used just for
	 *   this API call.
	 */
	registerDelete(options = {}) {
		_.defaults(options, this.options);
		this.apiRouter.register({
			method: options.routePrefix + '.delete',
			description: 'Delete ' + this.model.getName() + 's',
			schema: createSchema(objtools.merge({
				query: {
					type: 'documentQuery',
					modelName: this.model.getName(),
					modelType: this.model.getType(),
					documentSchema: this.model.getSchema(),
					required: true,
					description: 'The mongo-style query to execute'
				}
			}, options.extraParams || {}))
		},
		...(this.options.extraMiddleware),
		(ctx) => {
			return this.modelAccess.remove(this._makeParams({
				query: ctx.params.query
			}, ctx, options))
				.then(() => { return { success: true }; });
		});
	}

}

module.exports = ModelAccessRoutes;
