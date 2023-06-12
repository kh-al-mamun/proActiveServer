const express = require('express');
const cors = require('cors');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const app = express();
const stripe = require('stripe')(process.env.STRIPE_SK);
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

// middle wire
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('ProActive fitness server is running'));

const verifyJWT = (req, res, next) => {
    const authorization = req.headers.authorization;
    if (!authorization) {
        return res.status(401).send({ error: true, message: 'could not identify user' });
    }
    const token = authorization.split(' ')[1];
    jwt.verify(token, process.env.JWT_SECRET, (error, decoded) => {
        if (error) {
            return res.status(401).send({ error: true, message: 'could not identify user / unauthorized access' })
        }
        req.decoded = decoded;
        next();
    })
}

// mangoDB
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@craftawesome.bgwffom.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();
        const userCollection = client.db('proActiveFitnessDB').collection('users');
        const classCollection = client.db('proActiveFitnessDB').collection('classes');
        const paymentCollection = client.db('proActiveFitnessDB').collection('payments');

        //generate jwt token
        app.post('/jwt', async (req, res) => {
            const rawUser = req.body;
            const result = await userCollection.findOne({ email: rawUser.user.email })
            rawUser.user.role = result?.role || 'student';
            rawUser.user.isBanned = result?.isBanned || false;
            const token = jwt.sign(rawUser, process.env.JWT_SECRET, { expiresIn: '1h' });
            res.send(token);
        })

        //verify admin middleware
        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.user.email;
            const user = await userCollection.findOne({ email: decodedEmail });
            if (user.role !== 'admin') {
                return res.status(403).send({ error: true, message: 'forbidden access' });
            }
            next();
        }
        //verify instructor middleware
        const verifyInstructor = async (req, res, next) => {
            const decodedEmail = req.decoded.user.email;
            const user = await userCollection.findOne({ email: decodedEmail });
            if (user.role !== 'instructor') {
                return res.status(403).send({ error: true, message: 'forbidden access' });
            }
            next();
        }



        //================================================
        //============ user related apis =================
        //================================================
        app.get('/users', verifyJWT, verifyAdmin, async (req, res) => { //adminOnly route, used for getting all users data to show in a tabular form for admin to manage them
            const allUsers = await userCollection.find({}, { sort: { role: 1 } }).toArray();
            res.send(allUsers);
        })

        app.post('/users', async (req, res) => {
            const newUser = req.body;
            const isExist = await userCollection.findOne({ email: newUser.email });
            if (isExist) {
                return res.send({ message: 'User Exists In Database!' })
            }
            const result = await userCollection.insertOne(newUser);
            res.send(result);
        })

        app.get('/users/:email', verifyJWT, async (req, res) => {
            const email = req.params.email;
            const decodedEmail = req.decoded.user.email;
            if(decodedEmail !== email){
                return res.status(403).send({error: true, message: 'forbidden access'})
            }
            const result = await userCollection.findOne({ email: email });
            res.send(result);
        })

        app.patch('/users/:userId', verifyJWT, verifyAdmin, async (req, res) => { //adminOnly route, used for changing the role of a user (student/instructor/admin)
            const userId = req.params.userId;
            const updatedDoc = { $set: req.body };
            const result = await userCollection.updateOne({ _id: new ObjectId(userId) }, updatedDoc);
            res.send(result);
        })


        //================================================
        //============ class related apis =================
        //================================================
        app.get('/classes', async (req, res) => {
            const options = { sort: { enrolled_count: -1 } }
            if (req.query.status) {
                const result = await classCollection.find({ status: req.query.status }, options).toArray();
                return res.send(result);
            }
            if (req.query.email) {
                const result = await classCollection.find({ instructor_email: req.query.email }).toArray();
                return res.send(result);
            }
            const result = await classCollection.find({}, { sort: { status: -1 } }).toArray();
            res.send(result);
        })

        app.get('/classes/:type', verifyJWT, async (req, res) => {
            const type = req.params.type;
            const studentEmail = req.query.email;
            const student = await userCollection.findOne({ email: studentEmail });
            if (type === 'booked') {
                const query = { _id: { $in: student?.booked_classes.map(id => new ObjectId(id)) } }
                const bookedClasses = await classCollection.find(query).toArray();
                return res.send(bookedClasses);
            }
            else if (type === 'enrolled') {
                const query = { _id: { $in: student?.enrolled_classes.map(id => new ObjectId(id)) } }
                const enrolledClasses = await classCollection.find(query).toArray();
                return res.send(enrolledClasses);
            }
        })

        app.patch('/classes/:classId', verifyJWT, verifyAdmin, async (req, res) => { //adminOnly route, used for changing class status (approved/pending/denied) and feedback properties.
            const classId = req.params.classId;
            const updatedDoc = { $set: req.body };
            const result = await classCollection.updateOne({ _id: new ObjectId(classId) }, updatedDoc);
            res.send(result);
        })

        app.post('/classes', verifyJWT, verifyInstructor, async (req, res) => {
            const newClass = req.body;
            const result = await classCollection.insertOne(newClass);
            res.send(result);
        })

        //================================================
        //============ booking related apis ==============
        //================================================
        app.patch('/bookings', verifyJWT, async (req, res) => {
            const userEmail = req.query.email;
            const classId = req.query.classId;
            if (!userEmail || !classId) {
                return res.status(400).send({ error: true, message: 'invalid query syntax' });
            }
            const student = await userCollection.findOne({ email: userEmail });
            const bookedClasses = student.booked_classes;
            if (bookedClasses.indexOf(classId) === -1) {
                bookedClasses.splice(0, 0, classId);
            }
            else {
                const index = bookedClasses.indexOf(classId);
                bookedClasses.splice(index, 1)
            }
            const result = await userCollection.updateOne({ email: userEmail }, { $set: { booked_classes: bookedClasses } });
            res.send(result);
        })


        //================================================
        //=========== instructor related apis ============
        //================================================
        app.get('/instructors', async (req, res) => {
            const result = await userCollection.find({ role: 'instructor' }).toArray();
            res.send(result);
        })

        app.get('/popular-instructors', async (req, res) => {
            const options = { sort: { enrolled_count: -1 } }
            const topClasses = (await classCollection.find({}, options).toArray());
            const topSixInstructorEmails = topClasses.map(topClass => {
                const email = topClass.instructor_email;
                return email;
            })
            const topInstructors = await userCollection.find({ email: { $in: topSixInstructorEmails } }).toArray();
            res.send(topInstructors.slice(0, 6));
        })


        //================================================
        //=========== payments related apis ==============
        //================================================
        app.get('/payments/:email', async (req, res) => {
            const payments = await paymentCollection.find({ email: req.params.email }, {sort: {created: -1}}).toArray();
            res.send(payments);
        })

        app.post('/payments', async (req, res) => {
            const payment = req.body;
            const insertResult = await paymentCollection.insertOne(payment);

            const updateUserResult = await userCollection.updateOne(
                { email: payment.email },
                {
                    $set: { booked_classes: [] },
                    $push: { enrolled_classes: { $each: payment.enrolled_classes } }
                }
            )

            const query = { _id: { $in: payment.enrolled_classes.map(id => new ObjectId(id)) } }
            const updateClassesResult = await classCollection.updateMany(query, {
                $inc: { enrolled_count: 1 }
            })

            res.send({ insertResult, updateUserResult, updateClassesResult });
        })

        app.post('/create-payment-intent', async (req, res) => {
            const { items } = req.body;
            const totalPrice = parseInt(items.reduce((sum, cur) => sum + cur.price, 0).toFixed(2) * 100); //*100 for turning dollar to cents
            if (totalPrice <= 0) { return };
            const paymentIntent = await stripe.paymentIntents.create({
                amount: totalPrice,
                currency: 'usd',
                payment_method_types: ['card']
            })
            res.send({
                clientSecret: paymentIntent.client_secret,
                totalPrice: totalPrice / 100,
            })
        })




        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);





app.listen(port, () => console.log(`ProActive fitness server has been started at port ${port}`))