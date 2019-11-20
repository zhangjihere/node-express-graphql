var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

const esb = require('elastic-builder');
const graphqlHTTP = require('express-graphql');
const {graphqlExpress, graphiqlExpress} = require('apollo-server-express');
const {buildSchema} = require('graphql');
const got = require('got');
const HttpsProxyAgent = require('https-proxy-agent');
const SDC = require('statsd-client-cached');

const sdc = new SDC({
    host: process.env.Config_statsd_host || "13.209.72.232",
    // host: process.env.Config_statsd_host || "graphite-grafana-1.FaaSMonitorTest.srcb.ceres.local",
    port: process.env.Config_statsd_port || 8125,
    flushInterval: process.env.Config_statsd_flushInterval || 10000, // default: 10 seconds
    prefix: process.env.Config_statsd_prefix || "backend"
});

// Example for http to send log.
const http = require("http");
let options = {
    hostname: "13.209.72.232",
    port: 1092,
    path: "/",
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Content-Length": 0,
    },
};
function sendLog(msg1, msg2) {
    console.log(msg1, msg2)
    if (msg2 === undefined) {
        msg2 = ""
    }
    let msg = msg1 + msg2;
    let length = JSON.stringify({ "msg": msg }).length;
    options.headers["Content-Length"] = length;
    let req = http.request(options);
    // req.write(JSON.stringify({ "msg": msg }));
    // req.end();
}

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({extended: false}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/users', usersRouter);


let requestBody = esb.requestBodySearch()
    .version(true)
    .size(500)
    .query(esb.boolQuery()
        .must(esb.matchPhraseQuery('gs.app', 'hello'))
        .must(esb.matchPhraseQuery('gs.svcuser', 'guest'))
        .must(esb.rangeQuery('@timestamp').gte(1562737886567).lte(1562752286567).format('epoch_millis')))
    .sort(esb.sort('@timestamp','desc').unmappedType('date'))
    .agg(esb.dateHistogramAggregation('2', '@timestamp', '5m').timeZone('+08:00').minDocCount(0).extendedBounds(1562737886567, 1562752286567)
        .agg(esb.avgAggregation('1', 'gu.duration')));
let json = requestBody.toJSON();
console.log(json);

const requestES = async (es_query, api_name) => {
    let options = {};
    options.body = JSON.stringify({"index": "couchdb-*"}) + '\n' + JSON.stringify(es_query.toJSON()) + '\n';
    options.headers = {'Content-Type': 'application/x-ndjson'};
    if (process.env.https_proxy) {
        options.agent = new HttpsProxyAgent(process.env.https_proxy)
    }
    try {
        let response = await got.get(process.env.ELASTICSEARCH_HTTP_URL + '/_msearch', options);
        // console.debug(response.body);
        sdc.counter("api." + api_name + ".success", 1);
        return response.body;
    } catch (error) {
        console.error('ActivationMetric: ' + error.stack);
        sdc.counter("api." + api_name + ".failure", 1);
        throw error;
    }
};


// use graphql schema language to creat schema(type definition)
const schema = buildSchema(`
    type Query {
        rollDice(numDice: Int!, numSides: Int):[Int]
        activationMetricHistogram(
            size: Int!, 
            gs_app: String!, 
            gs_svcuser: String!, 
            time_min: String, 
            time_max: String, 
            range: String,
            interval: String!, 
            time_zone: String!, 
            type: String!,
            order: String): String
        activationMetric(activationId: String!): String
    }
`);

// root provide resolvers for each API endpoint.
const root = {
    rollDice: function ({numDice, numSides}) {
        let output = [];
        for (let i = 0; i < numDice; i++) {
            output.push(1 + Math.floor(Math.random() * (numSides || 6)));
        }
        return output;
    },
    activationMetricHistogram: function ({size, gs_app, gs_svcuser, time_min, time_max, range, interval, time_zone, type, order="desc"}) {
        if (range) {
            let num = Number(range.substring(0, range.length - 1));
            time_max = (new Date).getTime();
            time_min = time_max - num * 3600 * 1000;
        }
        let bool_query = esb.boolQuery()
            .must(esb.matchPhraseQuery('gs.app', gs_app))
            .must(esb.matchPhraseQuery('gs.svcuser', gs_svcuser))
            .must(esb.rangeQuery('@timestamp').gte(Number(time_min)).lte(Number(time_max)).format('epoch_millis'));
        let sort_options = esb.sort('@timestamp',order).unmappedType('date');
        let date_hist_agg = esb.dateHistogramAggregation('2', '@timestamp', interval)
            .timeZone(time_zone)
            .minDocCount(0)
            .extendedBounds(Number(time_min), Number(time_max));
        switch (type) {
            case 'error':
                // bool_query.must(esb.matchQuery('gs.status', 'error'));
                bool_query.mustNot(esb.matchPhraseQuery('gu.status', 'success'));
                break;
            case 'runtime':
                date_hist_agg.agg(esb.avgAggregation('1', 'gu.duration'));
                break;
            case 'invocation':
                break;
            default:
                break;
        }
        const es_query = esb.requestBodySearch()
            .version(true)
            .size(size)
            .query(bool_query)
            .sort(sort_options)
            .agg(date_hist_agg);
        return requestES(es_query, 'activationMetricHistogram');
    },
    activationMetric: function ({activationId}) {
        let bool_query = esb.boolQuery()
            .must(esb.matchQuery('gu.activationId', activationId));
        const es_query = esb.requestBodySearch()
            .version(true)
            .size(1)
            .query(bool_query);
        return requestES(es_query, 'activationMetric');
    }
};

app.use('/graphql', graphqlHTTP({
    schema: schema,
    rootValue: root,
    graphiql: true
}));
console.log('Running a GraphQL API server at localhost:3000/graphql');
// app.use('/graphiql', graphiqlExpress({ endpointURL: '/graphql' }));


// catch 404 and forward to error handler
app.use(function (req, res, next) {
    next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
    // set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};

    // render the error page
    res.status(err.status || 500);
    res.render('error');
});

module.exports = app;
