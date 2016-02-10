const decamelize = require('decamelize');
const { defaultSchemaFactory, createSchema } = require('zs-common-schema');
const { registerTypes } = require('zs-model-schema-types');
const _ = require('lodash');
const objtools = require('zs-objtools');
const XError = require('xerror');

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

	_makeParams(params, ctx, options = {}) {
		if (ctx.auth && ctx.auth.permissions) {
			params.permissions = ctx.auth.permissions;
		} else {
			throw new XError(XError.INTERNAL_ERROR, 'No permissions supplied on context');
		}
		for (let extraParam in (options.extraParams || {})) {
			if (typeof ctx.params[extraParam] !== 'undefined') {
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
		//// TODO: accept arbitrary keys, not just `id`
		_.defaults(options, this.options);
		this.apiRouter.register({
			method: options.routePrefix + '.get',
			description: 'Get a single ' + this.model.getName(),
			schema: createSchema(objtools.merge({
				id: {
					type: String,
					required: true,
					description: 'ID of object to get'
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
			return this.modelAccess.get(this._makeParams({
				id: ctx.params.id,
				fields: ctx.params.fields,
				extraFields: options.extraFields
			}, ctx, options))
				.then((result) => { result: result.data });
		});
	}

	/**
	 * Registers a route to query objects.
	 *
	 * @method registerQuery
	 * @param {Object} [options] - Any of the options supplied to the constructor, but used just for
	 *   this API call.
	 */
	registerQuery(options) {
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
				.then((results) => { results: _.map(results, 'data') });
		});
	}

	/**
	 * Registers a route to query objects in a stream.
	 *
	 * @method registerExport
	 * @param {Object} [options] - Any of the options supplied to the constructor, but used just for
	 *   this API call.
	 */
	 /*
	registerExport(options) {
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
			let params, query, options, resultFilter, sourceDataStream;

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

				});



			return this.modelAccess.query(this._makeParams({
				query: ctx.params.query,
				fields: ctx.params.fields,
				extraFields: options.extraFields,
				sort: ctx.params.sort,
				skip: ctx.params.skip,
				limit: ctx.params.limit
			}, ctx, options))
				.then((results) => { results: _.map(results, 'data') });
		});
	}*/

}

module.exports = ModelAccessRoutes;
