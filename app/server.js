const bodyParse = require('body-parser');
const livereload = require('livereload');
const connectLiveReload = require('connect-livereload');
const app = require('express')();
const moment = require('moment');
const Facilities = require('./models/Facilities');
const Courses = require('./models/Courses');
const Sports = require('./models/Sports');
const Bookings = require('./models/Bookings');
const OpeningHours = require('./models/OpeningHours');

// Live Reload configuration
const liveReloadServer = livereload.createServer();
liveReloadServer.server.once("connection", () => {
    setTimeout(() => {
        liveReloadServer.refresh("/");
    }, 100);
});

// Fontend route
const FrontRouter = require('./routes/front');

// Set ejs template engine
app.set('view engine', 'ejs');

app.use(connectLiveReload())

app.use(bodyParse.urlencoded({ extended: false }));
app.locals.moment = moment;

app.use(FrontRouter);


const PORT = process.env.PORT || 3000;
Facilities.initialize()
    .then(() => OpeningHours.initialize())
    .then(() => Courses.initialize())
    .then(() => Sports.initialize())
    .then(() => Bookings.initialize())
    .then(() => {
        console.log('PostgreSQL connected');
        app.listen(PORT, () => {
            console.log(`Server listening on port ${PORT}`);
        });
    })
    .catch(error => {
        console.error('Unable to initialize PostgreSQL:', error);
        process.exit(1);
    });