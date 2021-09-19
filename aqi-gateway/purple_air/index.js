const { Datastore } = require('@google-cloud/datastore');
const axios = require('axios');
var AWS = require('aws-sdk');
AWS.config.region = 'us-east-1';
AWS.config.logger = console;
var lambda = new AWS.Lambda({ 'region': 'us-east-1' });

/**
 * Demonstrates a simple HTTP endpoint using API Gateway. You have full
 * access to the request and response payload, including headers and
 * status code.
 *
 */
exports.handler = async(event, context) => {
  // console.log('Received event:', JSON.stringify(event, null, 2));

  let body;
  let statusCode = '200';
  const headers = {
    'Content-Type': 'application/json',
  };

  try {
    switch (event.httpMethod) {
      case 'GET':
        body = await purpleAirHandler(
          event.queryStringParameters.lat, event.queryStringParameters.lon, 
          event.queryStringParameters, event, context);
        break;
      default:
        throw new Error(`Unsupported method "${event.httpMethod}"`);
    }
  }
  catch (err) {
    console.log(`caught ${err}`);
    statusCode = '400';
    body = err.message;
  }
  finally {
    body = JSON.stringify(body);
  }

  return {
    statusCode,
    body,
    headers,
  };
};

const makeVisit = (req, conditions) => {
  // Create a visit record to be stored in the database
  return {
    timestamp: new Date(),
    latitude: req.lat,
    longitude: req.lon,
    model: req.device,
    aqi: conditions["PM2.5"]
  };
}

/**
 * Insert a visit record into the database.
 *
 * @param {object} visit The visit record to insert.
 */
const insertVisit = (visit, sysId) => {
  if (sysId === undefined) {
    return null;
  }
  if (visit.latitude === "0.0" || visit.latitude === "0" || visit.latitude === "0.000000" || parseFloat(visit.latitude) > 179.999999 || visit.latitude === "180.000000") {
    return null;
  }
  // Instantiate a datastore client
  const datastore = new Datastore();

  return datastore.save({
    key: datastore.key(['Device', sysId]),
    data: visit,
  });
};

const invokeIQAir = async(event, context) => {
  let result = null;
  var params = {
    FunctionName: 'iqair_gateway', // the lambda function we are going to invoke
    InvocationType: 'RequestResponse',
    LogType: 'Tail',
    Payload: JSON.stringify(event)
  };

  await lambda.invoke(params, (err, data) => {
    if (err) {
      console.error(`err ${err} ${err.stack}`);
      context.fail(err);
    }
    else {
      result = JSON.parse(JSON.parse(data.Payload).body);
    }
  }).promise();
  return result;
};

const purpleAirHandler = async(lat, lon, queryParams, event, context) => {
  let boundingBox = calcBoundingBox(parseFloat(lat), parseFloat(lon), 10);

  const purpleAirKey = process.env.PURPLE_AIR_KEY;
  let purpleAirUrl =
    `https://api.purpleair.com/v1/sensors?fields=pm2.5_cf_1,ozone1,humidity,latitude,longitude&location_type=0&nwlng=${boundingBox[0]}&nwlat=${boundingBox[2]}&selng=${boundingBox[1]}&selat=${boundingBox[3]}&api_key=${purpleAirKey}`;
  // console.info(`purpleAir url ${purpleAirUrl}`);

  try {
    let purpleairResult = await axios.get(purpleAirUrl).catch(async error => {
      console.error(`axios error at ${lat} ${lon}`, error.response.data);
      return await invokeIQAir(event, context);
    });
    if (purpleairResult.data.data[0] === undefined) {
      console.error(`No conditions returned from Purple Air inside ${boundingBox[2]},${boundingBox[0]} ; ${boundingBox[3]},${boundingBox[1]}`);
      return await invokeIQAir(event, context);
    }
    const conditions = processPurpleResults(lat, lon, queryParams, purpleairResult.data);
    if (conditions["PM2.5"] < 0) {
      return await invokeIQAir(event, context);
    }
    return conditions;

  }
  catch (err) {
    console.error(`No Purple Air results for ${lat},${lon} because : ${err}`);
    return await invokeIQAir(event, context);
  }
};

const toRad = function(val) {
  return val * Math.PI / 180;
};

const greatCircleRadius = {
  miles: 3956,
  km: 6367
};

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  var dLat = toRad((lat2 - lat1)),
    dLon = toRad((lon2 - lon1));

  lat1 = toRad(lat1);
  lat2 = toRad(lat2);

  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return greatCircleRadius.km * c;
};

// sort the results so that we take aqi from the closest sensor
const processPurpleResults = (lat, lon, queryParams, results) => {
  let pm25index = results.fields.indexOf('pm2.5_cf_1');
  let ozoneIndex = results.fields.indexOf('ozone1');
  let humidityIndex = results.fields.indexOf('humidity');
  let sensorLatitude = results.fields.indexOf('latitude');
  let sensorLongitude = results.fields.indexOf('longitude');
  results.data.sort((first, second) => {
    return calculateDistance(lat, lon, first[sensorLatitude], first[sensorLongitude]) - calculateDistance(lat, lon, second[sensorLatitude], second[sensorLongitude]);
  });
  let aqi = usEPAfromPm(results.data[0][pm25index], results.data[0][humidityIndex]);
  let conditions = { 'PM2.5': aqi, 'O3': results.data[0][ozoneIndex] };
  console.info(`conditions : ${JSON.stringify(conditions)}`);
  insertVisit(makeVisit(queryParams, conditions), queryParams.sysId);
  return (conditions);
};

const toDegrees = (radians) => radians * 180 / Math.PI;
const toRadians = (degrees) => degrees * Math.PI / 180;

const calcBoundingBox = (lat, lon, distInKm) => {
  const R = 6371; // radius of Earth in km

  let widthInDegrees = toDegrees(distInKm / R / Math.cos(toRadians(lat)));
  let x1 = lon - widthInDegrees;
  let x2 = lon + widthInDegrees;
  let heightInDegrees = toDegrees(distInKm / R);
  let y1 = lat + heightInDegrees;
  let y2 = lat - heightInDegrees;
  return [
    x1,
    x2,
    y1,
    y2
  ];
}

const usEPAfromPm = (pm, rh) => {
  const aqi = aqiFromPM(0.534 * pm - 0.0844 * rh + 5.604);
  if (aqi < 0) {
    console.warn(`weird AQI: PM=${pm} humidity=${rh}`);
    return aqi;
  }
  return aqi;
};

function aqiFromPM(pm) {

  if (isNaN(pm)) { return "-"; }
  if (pm == undefined) { return "-"; }
  if (pm < 0) { return pm; }
  if (pm > 1000) { return "-"; }

  //
  //       Good                              0 - 50         0.0 - 15.0         0.0 – 12.0
  // Moderate                        51 - 100           >15.0 - 40        12.1 – 35.4
  // Unhealthy for Sensitive Groups   101 – 150     >40 – 65          35.5 – 55.4
  // Unhealthy                                 151 – 200         > 65 – 150       55.5 – 150.4
  // Very Unhealthy                    201 – 300 > 150 – 250     150.5 – 250.4
  // Hazardous                                 301 – 400         > 250 – 350     250.5 – 350.4
  // Hazardous                                 401 – 500         > 350 – 500     350.5 – 500
  //
  if (pm > 350.5) {
    return calcAQI(pm, 500, 401, 500, 350.5);
  }
  else if (pm > 250.5) {
    return calcAQI(pm, 400, 301, 350.4, 250.5);
  }
  else if (pm > 150.5) {
    return calcAQI(pm, 300, 201, 250.4, 150.5);
  }
  else if (pm > 55.5) {
    return calcAQI(pm, 200, 151, 150.4, 55.5);
  }
  else if (pm > 35.5) {
    return calcAQI(pm, 150, 101, 55.4, 35.5);
  }
  else if (pm > 12.1) {
    return calcAQI(pm, 100, 51, 35.4, 12.1);
  }
  else if (pm >= 0) {
    return calcAQI(pm, 50, 0, 12, 0);
  }
  return undefined;
}

function calcAQI(Cp, Ih, Il, BPh, BPl) {

  var a = Ih - Il;
  var b = BPh - BPl;
  var c = Cp - BPl;
  return Math.round(a / b * c + Il);

}
