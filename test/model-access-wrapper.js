const { expect } = require('chai');
const { ModelAccessWrapper } = require('../lib');
const XError = require('xerror');
const _ = require('lodash');
const { Animal, testAnimals, permissionSets } = require('./lib/fake-data');


describe('Model Access', function() {

	beforeEach(function() {
		Animal.clear();
		return Animal.insertMulti(testAnimals);
	});

	describe('Wrapper', function() {

		describe('get()', function() {
			it('basic functionality', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.get({
					keys: { id: 'biz' },
					permissions: permissionSets.everything
				})
					.then((result) => {
						expect(result.doc.data.id).to.equal('biz');
						delete result.data._id;
						expect(result.data).to.deep.equal({
							id: 'biz',
							animalType: 'horse',
							name: 'Lightning',
							age: 3
						});
					});
			});

			it('permission denied', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.get({
					keys: { id: 'biz' },
					permissions: permissionSets.noRead
				})
					.then(() => {
						throw new Error('Expected error');
					}, (err) => {
						expect(err.code).to.equal(XError.ACCESS_DENIED);
					});
			});

			it('filtered result', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.get({
					keys: { id: 'biz' },
					permissions: permissionSets.partialRead
				})
					.then((result) => {
						expect(result.doc.data.id).to.equal('biz');
						delete result.data._id;
						expect(result.data).to.deep.equal({
							id: 'biz',
							animalType: 'horse'
						});
					});
			});

			it('pre-get hook', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				let calledHook = false;
				wrapper.hook('pre-get', () => {
					calledHook = true;
				});
				return wrapper.get({
					keys: { id: 'biz' },
					permissions: permissionSets.everything
				})
					.then((result) => {
						expect(result.doc.data.id).to.equal('biz');
						expect(calledHook).to.equal(true);
					});
			});

			it('serialize', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal,
					serialize(doc) {
						return {
							origId: doc.data.id,
							foo: 'bar'
						};
					}
				});
				return wrapper.get({
					keys: { id: 'biz' },
					permissions: permissionSets.everything
				})
					.then((result) => {
						expect(result.doc.data.id).to.equal('biz');
						expect(result.data).to.deep.equal({
							origId: 'biz',
							foo: 'bar'
						});
					});
			});
		});


		describe('query()', function() {

			it('basic functionality', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.query({
					query: { age: { $gt: 4 } },
					sort: [ 'id' ],
					fields: [ 'name' ],
					permissions: permissionSets.everything
				})
					.then((results) => {
						expect(_.map(results, 'data')).to.deep.equal([
							{ name: 'Felix' },
							{ name: 'Toby' }
						]);
					});
			});

			it('partial results', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.query({
					query: { id: 'biz' },
					permissions: permissionSets.partialRead
				})
					.then((results) => {
						expect(results.length).to.equal(1);
						expect(results[0].doc.data.id).to.equal('biz');
						delete results[0].data._id;
						expect(results[0].data).to.deep.equal({
							id: 'biz',
							animalType: 'horse'
						});
					});
			});

			it('filtered results', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.query({
					query: {},
					permissions: permissionSets.singleDoc
				})
					.then((results) => {
						expect(results[0]).to.equal(null);
						expect(results[1]).to.equal(null);
						expect(results[3]).to.equal(null);
						expect(results[4]).to.equal(null);
						expect(results[5]).to.equal(null);
						expect(results[2].data.id).to.equal('baz');
					});
			});

			it('query on disallowed field', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.query({
					query: { age: { $gt: 4 } },
					permissions: permissionSets.partialRead
				})
					.then(() => {
						throw new Error('Expected error');
					}, (err) => {
						expect(err.code).to.equal(XError.ACCESS_DENIED);
					});
			});

		});


		describe('stream()', function() {

			it('basic functionality', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.stream({
					query: { age: { $gt: 4 } },
					sort: [ 'id' ],
					fields: [ 'name' ],
					permissions: permissionSets.everything
				})
					.then((stream) => stream.intoArray())
					.then((results) => {
						expect(_.map(results, 'data')).to.deep.equal([
							{ name: 'Felix' },
							{ name: 'Toby' }
						]);
					});
			});

		});


		describe('count()', function() {

			it('basic functionality', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.count({
					query: { age: { $gt: 4 } },
					permissions: permissionSets.everything
				})
					.then((result) => {
						expect(result).to.equal(2);
					});
			});

		});


		describe('aggregateMulti()', function() {

			it('basic functionality', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.aggregateMulti({
					query: {},
					aggregates: {
						testAggr: {
							groupBy: 'animalType',
							stats: {
								age: {
									max: true
								}
							}
						}
					},
					permissions: permissionSets.everything
				})
					.then((results) => {
						expect(results).to.deep.equal({
							testAggr: [
								{
									key: [ 'cat' ],
									stats: {
										age: { max: 8 }
									}
								},
								{
									key: [ 'dog' ],
									stats: {
										age: { max: 2 }
									}
								},
								{
									key: [ 'horse' ],
									stats: {
										age: { max: 4 }
									}
								},
								{
									key: [ 'frog' ],
									stats: {
										age: { max: 1 }
									}
								}
							]
						});
					});
			});

			it('aggregate on disallowed field', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.aggregateMulti({
					query: {},
					aggregates: {
						testAggr: {
							groupBy: 'animalType',
							stats: {
								age: {
									max: true
								}
							}
						}
					},
					permissions: permissionSets.partialRead
				})
					.then(() => {
						throw new Error('Expected error');
					}, (err) => {
						expect(err.code).to.equal(XError.ACCESS_DENIED);
					});
			});

		});


		describe('put()', function() {

			it('basic functionality', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.put({
					data: {
						id: 'asdf',
						animalType: 'frog',
						name: 'ASDF',
						age: 99
					},
					permissions: permissionSets.everything
				})
					.then(() => Animal.find({ id: 'asdf' }))
					.then((results) => {
						expect(results.length).to.equal(1);
						delete results[0].data._id;
						expect(results[0].data).to.deep.equal({
							id: 'asdf',
							animalType: 'frog',
							name: 'ASDF',
							age: 99
						});
					});
			});

			it('partial write permissions success', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.put({
					data: {
						id: 'asdf',
						animalType: 'frog'
					},
					permissions: permissionSets.partialWrite
				})
					.then(() => Animal.find({ id: 'asdf' }))
					.then((results) => {
						expect(results.length).to.equal(1);
						delete results[0].data._id;
						expect(results[0].data).to.deep.equal({
							id: 'asdf',
							animalType: 'frog'
						});
					});
			});

			it('partial write permissions failure', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.put({
					data: {
						id: 'asdf',
						animalType: 'frog',
						age: 5
					},
					permissions: permissionSets.partialWrite
				})
					.then(() => {
						throw new Error('Expected error');
					}, (err) => {
						expect(err.code).to.equal(XError.ACCESS_DENIED);
					});
			});

		});


		describe('upsert()', function() {

			it('updates existing documents', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.upsert({
					query: { name: 'Felix' },
					update: { $set: { age: 10 } },
					permissions: permissionSets.everything
				})
					.then(() => Animal.findOne({ id: 'baz' }))
					.then((doc) => {
						expect(doc.data.age).to.equal(10);
					});
			});

			it('inserts new documents', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.upsert({
					query: { id: 'test', name: 'Zag' },
					update: { $set: { age: 10 } },
					permissions: permissionSets.everything
				})
					.then(() => Animal.findOne({ id: 'test' }))
					.then((doc) => {
						delete doc.data._id;
						expect(doc.data).to.deep.equal({
							id: 'test',
							name: 'Zag',
							age: 10
						});
					});
			});

			it('partial write permissions success', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.upsert({
					query: { id: 'foo' },
					update: { $set: { animalType: 'dog' } },
					permissions: permissionSets.partialWrite
				})
					.then(() => Animal.findOne({ id: 'foo' }))
					.then((doc) => {
						expect(doc.data.animalType).to.equal('dog');
					});
			});

			it('partial write permissions failure', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.upsert({
					query: { id: 'foo' },
					update: { $set: { age: 50 } },
					permissions: permissionSets.partialWrite
				})
					.then(() => {
						throw new Error('Expected error');
					}, (err) => {
						expect(err.code).to.equal(XError.ACCESS_DENIED);
					});
			});

			it('document-specific permission update success', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.upsert({
					query: { age: 8 },
					update: { $set: { animalType: 'dog' } },
					permissions: permissionSets.singleDoc
				})
					.then(() => Animal.findOne({ id: 'baz' }))
					.then((doc) => {
						expect(doc.data.animalType).to.equal('dog');
					});
			});

			it('document-specific permission update failure', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.upsert({
					query: { age: 5 },
					update: { $set: { animalType: 'dog' } },
					permissions: permissionSets.singleDoc
				})
					.then(() => {
						throw new Error('Expected error');
					}, (err) => {
						expect(err.code).to.equal(XError.ACCESS_DENIED);
					});
			});

			it('document-specific permission insert success', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.upsert({
					query: { age: 123 },
					update: { $set: { name: 'Felix', id: 'asdf', animalType: 'cat' } },
					permissions: permissionSets.singleDoc
				})
					.then(() => Animal.findOne({ id: 'asdf' }))
					.then((doc) => {
						expect(doc.data.animalType).to.equal('cat');
						expect(doc.data.age).to.equal(123);
					});
			});

			it('document-specific permission insert failure', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.upsert({
					query: { age: 123 },
					update: { $set: { name: 'Furball', id: 'asdf', animalType: 'cat' } },
					permissions: permissionSets.singleDoc
				})
					.then(() => {
						throw new Error('Expected error');
					}, (err) => {
						expect(err.code).to.equal(XError.ACCESS_DENIED);
					});
			});

		});


		describe('update()', function() {

			it('basic functionality', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.update({
					query: { name: 'Felix' },
					update: { $set: { age: 10 } },
					permissions: permissionSets.everything
				})
					.then(() => Animal.findOne({ id: 'baz' }))
					.then((doc) => {
						expect(doc.data.age).to.equal(10);
					});
			});

			it('partial write permissions success', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.update({
					query: { id: 'baz' },
					update: { $set: { animalType: 'dog' } },
					permissions: permissionSets.partialWrite
				})
					.then(() => Animal.findOne({ id: 'baz' }))
					.then((doc) => {
						expect(doc.data.animalType).to.equal('dog');
					});
			});

			it('partial write permissions failure', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.update({
					query: { id: 'baz' },
					update: { $set: { age: 1 } },
					permissions: permissionSets.partialWrite
				})
					.then(() => {
						throw new Error('Expected error');
					}, (err) => {
						expect(err.code).to.equal(XError.ACCESS_DENIED);
					});
			});

			it('document-specific permission success', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.update({
					query: { id: 'baz' },
					update: { $set: { animalType: 'dog' } },
					permissions: permissionSets.singleDoc
				})
					.then(() => Animal.findOne({ id: 'baz' }))
					.then((doc) => {
						expect(doc.data.animalType).to.equal('dog');
					});
			});

			it('document-specific permission failure', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.update({
					query: { id: 'foo' },
					update: { $set: { animalType: 'dog' } },
					permissions: permissionSets.singleDoc
				})
					.then(() => {
						throw new Error('Expected error');
					}, (err) => {
						expect(err.code).to.equal(XError.ACCESS_DENIED);
					});
			});

		});


		describe('remove()', function() {

			it('basic functionality', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.remove({
					query: { age: { $gt: 4 } },
					permissions: permissionSets.everything
				})
					.then(() => Animal.find({}))
					.then((results) => {
						expect(results.length).to.equal(4);
					});
			});

			it('permission failure', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.remove({
					query: { age: { $gt: 4 } },
					permissions: permissionSets.noRead
				})
					.then(() => {
						throw new Error('Expected error');
					}, (err) => {
						expect(err.code).to.equal(XError.ACCESS_DENIED);
					});
			});

			it('document-specific permission success', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.remove({
					query: { id: 'baz' },
					permissions: permissionSets.singleDoc
				})
					.then(() => Animal.find({}))
					.then((results) => {
						expect(results.length).to.equal(5);
					});
			});

			it('document-specific permission failure', function() {
				let wrapper = new ModelAccessWrapper({
					model: Animal
				});
				return wrapper.remove({
					query: { id: 'foo' },
					permissions: permissionSets.singleDoc
				})
					.then(() => {
						throw new Error('Expected error');
					}, (err) => {
						expect(err.code).to.equal(XError.ACCESS_DENIED);
					});
			});

		});

	});

});
