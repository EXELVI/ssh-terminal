const mongodb = require("mongodb").MongoClient;

const databasePromise = mongodb.connect(process.env.mongodb, { 

});

module.exports = databasePromise;