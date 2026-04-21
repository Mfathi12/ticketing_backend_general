const mongoose = require('mongoose');
require('dotenv').config();

const mongoURI = process.env.MONGODB_URI || 'mongodb://ticketing_user:TicketApp2025!@localhost:27017/ticketing_db?authSource=ticketing_db';

async function fixTicketIndexes() {
    try {
        // Connect to MongoDB
        await mongoose.connect(mongoURI);
        console.log('Connected to MongoDB');

        const db = mongoose.connection.db;
        const collection = db.collection('tickets');

        // List all indexes
        const indexes = await collection.indexes();
        console.log('\nCurrent indexes:', JSON.stringify(indexes, null, 2));

        // Check if old unique index on ticket exists
        const oldTicketIndex = indexes.find(idx => 
            idx.key && idx.key.ticket === 1 && !idx.key.project && idx.unique === true
        );

        if (oldTicketIndex) {
            console.log('\n⚠️  Found old unique index on ticket field:', oldTicketIndex.name);
            console.log('Dropping old index:', oldTicketIndex.name);
            
            try {
                await collection.dropIndex(oldTicketIndex.name);
                console.log('✅ Successfully dropped old index');
            } catch (dropError) {
                if (dropError.codeName === 'IndexNotFound') {
                    console.log('ℹ️  Index already removed');
                } else {
                    throw dropError;
                }
            }
        } else {
            console.log('\n✅ No old unique index on ticket field found');
        }

        // Check if compound index exists
        const compoundIndex = indexes.find(idx => 
            idx.key && 
            idx.key.ticket === 1 && 
            idx.key.project === 1 && 
            idx.unique === true
        );

        if (!compoundIndex) {
            console.log('\nCreating compound unique index on { ticket: 1, project: 1 }');
            await collection.createIndex(
                { ticket: 1, project: 1 }, 
                { unique: true, name: 'ticket_1_project_1' }
            );
            console.log('✅ Successfully created compound index');
        } else {
            console.log('\n✅ Compound index already exists');
        }

        // List indexes after changes
        const finalIndexes = await collection.indexes();
        console.log('\nFinal indexes:', JSON.stringify(finalIndexes, null, 2));
        
        console.log('\n✅ Migration completed successfully!');
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    } finally {
        await mongoose.connection.close();
        console.log('\nDatabase connection closed');
    }
}

// Run the migration
fixTicketIndexes();

