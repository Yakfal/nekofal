import React, { createContext, useContext, useState } from 'react';

// Create a context for search state
const SearchContext = createContext({
  searchQuery: '',
  setSearchQuery: () => {}
});

export const SearchProvider = ({ children }) => {
  const [searchQuery, setSearchQuery] = useState('');
  
  return (
    <SearchContext.Provider value={{ searchQuery, setSearchQuery }}>
      {children}
    </SearchContext.Provider>
  );
};

export const useSearchContext = () => useContext(SearchContext);

export default SearchContext;