const { expect } = require('chai');
const { ModelAccessWrapper, ModelAccessRoutes } = require('../lib');
const XError = require('xerror');
const _ = require('lodash');
const { Animal, testAnimals, permissionSets } = require('./lib/fake-data');
const { APIRouter, JSONRPCInterface } = require('zs-api-router');
const express = require('express');
const supertest = require('supertest');
const { deepCopy } = require('zs-objtools');

function buildTestApp(options = {}, callSpecificOptions = {}) {
	const router = new APIRouter();
	const app = express();
	app.use(router.getExpressRouter());
	router.version(1).addInterface(new JSONRPCInterface({
		includeErrorStack: true
	}));
	const wrapperOptions = _.pick(options, [ 'serialize', 'permissionsTarget', 'allowNoPermissions' ]);
	wrapperOptions.model = Animal;
	const wrapper = new ModelAccessWrapper(wrapperOptions);
	const routeOptions = _.pick(options, [ 'routePrefix', 'extraMiddleware', 'extraParams' ]);
	let permissions = options.permissions || permissionSets.everything;
	if (!_.isArray(routeOptions.extraMiddleware)) routeOptions.extraMiddleware = [];
	routeOptions.extraMiddleware.unshift(function(ctx) {
		ctx.auth = {
			permissions
		};
	});
	const routes = new ModelAccessRoutes(wrapper, router, routeOptions);

	routes.register([], callSpecificOptions);

	return { router, app, wrapper, routes };
}

function jsonrpc(app, method, params = {}) {
	return new Promise((resolve, reject) => {
		supertest(app)
			.post('/v1/jsonrpc')
			.send({
				id: 'aoeu', // Hi Ross!
				method,
				params
			})
			.set('Content-type', 'application/json')
			.expect(200)
			.end((err, response) => {
				if (err) {
					reject(err);
				} else if (!response.body) {
					reject(new XError(XError.INTERNAL_ERROR, 'No response body'));
				} else if (response.body.error) {
					reject(response.body.error);
				} else {
					resolve(response.body.result);
				}
			});
	});
}

function jsonrpcRaw(app, method, params = {}) {
	return new Promise((resolve, reject) => {
		supertest(app)
			.post('/v1/jsonrpc')
			.send({
				id: 'aoeu',
				method,
				params
			})
			.set('Content-type', 'application/json')
			.expect(200)
			.end((err, response) => {
				if (err) {
					reject(err);
				} else {
					resolve(response.text);
				}
			});
	});
}


describe('Routes', function() {

	beforeEach(function() {
		Animal.clear();
		return Animal.insertMulti(testAnimals);
	});

	describe('get', function() {

		it('basic functionality', function() {
			const { app } = buildTestApp();
			return jsonrpc(app, 'animal.get', { keys: { id: 'foo' } })
				.then((result) => {
					expect(result.result.id).to.equal('foo');
					expect(result.result.name).to.equal('Toby');
				});
		});

		it('with fields', function() {
			const { app } = buildTestApp();
			return jsonrpc(app, 'animal.get', {
				keys: { id: 'foo' },
				fields: [ 'animalType', 'name' ]
			})
				.then((result) => {
					expect(result.result.id).to.not.exist;
					expect(result.result.name).to.equal('Toby');
					expect(result.result.animalType).to.equal('cat');
				});
		});

		it('permission denied', function() {
			const { app } = buildTestApp({ permissions: permissionSets.noRead });
			return jsonrpc(app, 'animal.get', {
				keys: { id: 'foo' }
			})
				.then(() => {
					throw new Error('Expected error');
				}, (err) => {
					expect(err.code).to.equal(XError.ACCESS_DENIED);
				});
		});

	});


	describe('query', function() {

		it('basic functionality', function() {
			const { app } = buildTestApp();
			return jsonrpc(app, 'animal.query', {
				query: { age: { $gt: 4 } },
				fields: [ 'name', 'id' ],
				sort: [ 'id' ]
			})
				.then((result) => {
					expect(result.results).to.deep.equal([
						{ id: 'baz', name: 'Felix' },
						{ id: 'foo', name: 'Toby' }
					]);
				});
		});

		it('skip & limit', function() {
			const { app } = buildTestApp();
			return jsonrpc(app, 'animal.query', {
				query: {},
				fields: [ 'id' ],
				sort: [ 'id' ],
				skip: 1,
				limit: 2
			})
				.then((result) => {
					expect(result.results).to.deep.equal([
						{ id: 'baz' },
						{ id: 'biz' }
					]);
				});
		});

	});

	describe('export', function() {

		it('basic functionality', function() {
			const { app } = buildTestApp();
			return jsonrpcRaw(app, 'animal.export', {
				query: {},
				fields: [ 'id', 'name' ]
			})
				.then((result) => {
					let expected = '{"data":{"id":"foo","name":"Toby"}}\n' +
						'{"data":{"id":"bar","name":"Ruff"}}\n' +
						'{"data":{"id":"baz","name":"Felix"}}\n' +
						'{"data":{"id":"qux","name":"Sammy"}}\n' +
						'{"data":{"id":"biz","name":"Lightning"}}\n' +
						'{"data":{"id":"boop","name":"Zippy"}}\n' +
						'{"success":true}\n';
					expect(result).to.equal(expected);
				});
		});

		it('access denied', function() {
			const { app } = buildTestApp({
				permissions: permissionSets.noRead
			});
			return jsonrpcRaw(app, 'animal.export', {
				query: {},
				fields: [ 'id', 'name' ]
			})
				.then((result) => {
					let parts = _.filter(result.split('\n'));
					expect(parts.length).to.equal(1);
					let obj = JSON.parse(parts[0]);
					expect(obj.success).to.equal(false);
					expect(obj.error.code).to.equal('access_denied');
				});
		});

		it('error partway through', function() {
			let docCtr = 0;
			const { app } = buildTestApp({
				serialize(doc) {
					if (docCtr < 2) {
						docCtr++;
						return deepCopy(doc.getData());
					} else {
						throw new XError(XError.INTERNAL_ERROR, 'Test error');
					}
				}
			});
			return jsonrpcRaw(app, 'animal.export', {
				query: {},
				fields: [ 'id', 'name' ]
			})
				.then((result) => {
					let expected = '{"data":{"id":"foo","name":"Toby"}}\n' +
						'{"data":{"id":"bar","name":"Ruff"}}\n' +
						'{"success":false,"error":{"code":"internal_error","message":"Test error"}}\n';
					expect(result).to.equal(expected);
				});
		});

	});


	describe('count', function() {

		it('basic functionality', function() {
			const { app } = buildTestApp();
			return jsonrpc(app, 'animal.count', {
				query: {}
			})
				.then((result) => {
					expect(result).to.deep.equal({
						result: 6
					});
				});
		});

	});


	describe('aggregate', function() {

		it('basic functionality', function() {
			const { app } = buildTestApp();
			return jsonrpc(app, 'animal.aggregate', {
				query: {},
				aggregates: {
					foo: {
						groupBy: 'animalType',
						total: true
					}
				}
			})
				.then((results) => {
					const expected = {
						results: {
							foo: [
								{
									key: [ 'cat' ],
									total: 2
								},
								{
									key: [ 'dog' ],
									total: 1
								},
								{
									key: [ 'horse' ],
									total: 2
								},
								{
									key: [ 'frog' ],
									total: 1
								}
							]
						}
					};
					expect(results).to.deep.equal(expected);
				});
		});

	});


	describe('put', function() {

		it('basic functionality', function() {
			const { app } = buildTestApp();
			return jsonrpc(app, 'animal.put', {
				data: {
					id: 'asdf',
					animalType: 'cat',
					name: 'qwerty',
					age: 5
				}
			})
				.then((result) => {
					expect(result).to.deep.equal({ success: true, keys: { id: 'asdf' } });
				})
				.then(() => {
					return Animal.findOne({ id: 'asdf' });
				})
				.then((result) => {
					expect(result.data.name).to.equal('qwerty');
				});
		});

	});

	describe('putMulti', function() {

		it('basic functionality', function() {
			const { app } = buildTestApp();
			return jsonrpc(app, 'animal.put-multi', {
				data: [ {
					id: 'test1',
					animalType: 'cat',
					name: 'Toby',
					age: 5
				},
				{
					id: 'test2',
					animalType: 'dog',
					name: 'Ruff',
					age: 2
				},
				{
					id: 'test3',
					animalType: 'cat',
					name: 'Luna',
					age: 8
				} ]
			})
				.then((result) => {
					expect(result).to.deep
						.equal({ success: true, keys: [ { id: 'test1' }, { id: 'test2' }, { id: 'test3' } ] });
				})
				.then(() => {
					return Animal.findOne({ id: 'test1' });
				})
				.then((result) => {
					expect(result.data.name).to.equal('Toby');
				})
				.then(() => {
					return Animal.findOne({ id: 'test2' });
				})
				.then((result) => {
					expect(result.data.name).to.equal('Ruff');
				})
				.then(() => {
					return Animal.findOne({ id: 'test3' });
				})
				.then((result) => {
					expect(result.data.name).to.equal('Luna');
				});

		});

	});


	describe('update', function() {

		it('basic functionality', function() {
			const { app } = buildTestApp();
			return jsonrpc(app, 'animal.update', {
				query: {
					animalType: 'cat'
				},
				update: {
					$set: {
						age: 444
					}
				}
			})
				.then((result) => {
					expect(result).to.deep.equal({ success: true });
				})
				.then(() => {
					return Animal.find({ animalType: 'cat' });
				})
				.then((results) => {
					expect(_.map(results, 'data.age')).to.deep.equal([ 444, 444 ]);
				});
		});

		it('upsert', function() {
			const { app } = buildTestApp();
			return jsonrpc(app, 'animal.update', {
				query: {
					id: 'asdf',
					animalType: 'cat'
				},
				update: {
					$set: {
						age: 444
					}
				},
				upsert: true
			})
				.then((result) => {
					expect(result).to.deep.equal({ success: true });
				})
				.then(() => {
					return Animal.findOne({ id: 'asdf' });
				})
				.then((result) => {
					delete result.data._id;
					expect(result.data).to.deep.equal({
						id: 'asdf',
						animalType: 'cat',
						age: 444
					});
				});
		});

	});


	describe('delete', function() {

		it('basic functionality', function() {
			const { app } = buildTestApp();
			return jsonrpc(app, 'animal.delete', {
				query: {
					animalType: 'horse'
				}
			})
				.then((result) => {
					expect(result).to.deep.equal({ success: true });
				})
				.then(() => {
					return Animal.find({ animalType: 'horse' });
				})
				.then((results) => {
					expect(results.length).to.equal(0);
				});
		});

	});

});
