# Unimodel CRUD Access Routes

This library registers routes with a yaar application for CRUD on unimodel models.
These routes provide permissions evaluation, input validation, result formatting, etc.
This library also provides a wrapper on top of unimodel models that allow for permissions evaluation
in a user context without calling a route.  This wrapper is not documented here; instead, check the
yuidoc comments.

## Registering Routes

```js
const { ModelAccessWrapper, ModelAccessRoutes } = require('unimodel-crud-routes');
const { APIRouter } = require('yaar');
const express = require('express');

const router = new APIRouter();
const app = express();
app.use(router.getExpressRouter());

const myModelWrapper = new ModelAccessWrapper({
	model: MyModel
});
const myModelRoutes = new ModelAccessRoutes(myModelWrapper, router, {
	// Note: myAuthMiddleware is a function(ctx) that is expected to add `ctx.auth.permissions`
	extraMiddleware: [ myAuthMiddleware ]
});
myModelRoutes.register();
```

The `ModelAccessWrapper` takes the following options:

- `model`: The model to wrap.
- `keys`: An array of field paths that represent required key fields.  If not supplied, this is
  determined by scanning the schema for any field marked with `{ key: true }`, just like
  in `SchemaModel#getKeys()` .
- `serialize`: This is a function that converts a result document into the data sent to the client.
  It's in the form: `function(doc, params)`.
  The default for this is: `function(doc) { return objtools.deepCopy(doc.getData()); }`
- `permissionsTarget`: The string used for the `target` value of permissions.  This defaults to
  `model.getName()` .

The `ModelAccessRoutes` takes the following options:

- `routePrefix`: The prefix to use for routes.  By default, this is the lowercased-and-hyphenated
  version of `model.getName()` .  So, if your model name is `ItemPrices`, the route prefix will
  default to "item-prices." .
- `extraMiddleware`: This is an array of middleware functions for yaar.  These middleware
  functions are run after parameter validation, but before any processing.  There is expected to be
  at least one middleware here that sets `ctx.auth.permissions` for permissions evaluation.
- `extraParams`: This is an array of extra parameters that the API calls accept and are passed through
  to the various unimodel functions.  It is a common-schema-style object.  For example, if you wanted
  to allow passing a parameter called `engine` through to `find()`, you could set `extraParams` to
  `{ engine: { type: String, default: 'mongo' } }` .

## Route Syntax

The following routes are registered:

### get

The `get` route (ie, `item-prices.get`) fetches a single item.  It takes the following parameters:

- `keys`: An object containing each of the key fields of the object to get.  Ie, if the object
  has a key called `id`, this could be: `{ keys: { id: 'foo' } }`
- `fields`: An array of field paths to return.  Defaults to every field.

It returns a result like this:

```js
{
	result: <Object>
}
```

### query

Query and fetch multiple items.  It takes the following parameters:

- `query`: The common-query query.
- `fields`
- `sort`: An array of field paths to sort by.  Fields can be prefixed with `-` to reverse order.
- `skip`: Number of items to skip before returning anything.
- `limit`: Maximum number of items to return.

It returns a result like this:

```js
{
	results: [
		{ <Object 1> },
		{ <Object 2> }
	]
}
```

### export

Bulk, streaming export of data.  It takes the following parameters:

- `query`
- `fields`
- `sort`

The result is not a standard API result.  Instead, it's a stream of newline-separated JSON objects,
where each object is a result.  The very last line returned will be one of:
`{ success: true }` or
`{ success: false, error: { code: 'foo', message: 'bar' } }`

### count

Return a count of matching documents.  It takes the following parameters:

- `query`

The result looks like:

```js
{
	result: 5
}
```

### aggregate

Perform common-query aggregates on the data.  It takes the following parameters:

- `query`
- `aggregates`: A map from aggregate names to common-query aggregate specs.
- `sort`
- `limit`
- `scanLimit`: Max number of documents to scan for the aggregate.

The result looks like:

```js
{
	results: {
		<AggregateName>: {
			/* Aggregate Results */
		}
	}
}
```

### put

Insert or replace a single object.  It takes the following parameters:

- `data`: Object data to insert or replace.

The result is always `{ success: true }` .

### update

Update multiple records at once.  It takes the following parameters:

- `query`
- `update`: Common-query update expression.
- `upsert`: If set to boolean `true`, and `query` matches nothing, a new document is inserted instead.

The result is always `{ success: true }` .

### delete

Remove multiple records at once.  It takes the following parameters:

- `query`

The result is always `{ success: true }` .


