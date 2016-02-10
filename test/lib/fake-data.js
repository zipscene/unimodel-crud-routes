const { FakeModel } = require('zs-unimodel-fake');
const PermissionSet = require('zs-permission');

const Animal = new FakeModel('Animal', {
	id: {
		type: String,
		required: true,
		key: true
	},
	animalType: {
		type: String,
		enum: [ 'cat', 'dog', 'horse', 'frog' ]
	},
	name: String,
	age: Number
});

const testAnimals = [
	{
		id: 'foo',
		animalType: 'cat',
		name: 'Toby',
		age: 5
	},
	{
		id: 'bar',
		animalType: 'dog',
		name: 'Ruff',
		age: 2
	},
	{
		id: 'baz',
		animalType: 'cat',
		name: 'Felix',
		age: 8
	},
	{
		id: 'qux',
		animalType: 'horse',
		name: 'Sammy',
		age: 4
	},
	{
		id: 'biz',
		animalType: 'horse',
		name: 'Lightning',
		age: 3
	},
	{
		id: 'boop',
		animalType: 'frog',
		name: 'Zippy',
		age: 1
	}
];

const permissionSets = {
	noRead: new PermissionSet([ {
		target: 'Animal',
		match: {},
		grant: {}
	} ]),
	partialRead: new PermissionSet([ {
		target: 'Animal',
		match: {},
		grant: {
			read: true,
			query: true,
			aggregate: true,
			readMask: {
				id: true,
				animalType: true
			}
		}
	} ]),
	partialWrite: new PermissionSet([ {
		target: 'Animal',
		match: {},
		grant: {
			read: true,
			query: true,
			aggregate: true,
			write: true,
			readMask: {
				id: true,
				animalType: true
			},
			writeMask: {
				id: true,
				animalType: true
			}
		}
	} ]),
	singleDoc: new PermissionSet([
		{
			target: 'Animal',
			match: {
				name: 'Felix'
			},
			grant: true
		},
		{
			target: 'Animal',
			match: {},
			grant: {
				query: true,
				readMask: true
			}
		}
	]),
	everything: new PermissionSet([ {
		target: 'Animal',
		match: {},
		grant: true
	} ])
};

module.exports = {
	Animal,
	testAnimals,
	permissionSets
};
