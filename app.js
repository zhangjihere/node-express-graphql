var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

const esb = require('elastic-builder');

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

const requestBody = esb.requestBodySearch()
    .version(true)
    .size(500)
    .query(esb.boolQuery()
        .must(esb.matchPhraseQuery('gs.app', 'hello'))
        .must(esb.matchPhraseQuery('gs.svcuser', 'guest'))
        .must(esb.rangeQuery('@timestamp').gte(1562737886567).lte(1562752286567).format('epoch_millis')))
    .agg(esb.dateHistogramAggregation('2', '@timestamp', '5m').timeZone('+08:00').minDocCount(0).extendedBounds(1562737886567, 1562752286567)
        .agg(esb.avgAggregation('1', 'gu.duration')));


var json = requestBody.toJSON();
console.log(json);


module.exports = app;
